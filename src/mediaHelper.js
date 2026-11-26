'use strict';

/**
 * SIGMA MD :: Shared Baileys v7 JID, Unwrap, Media, Channel & Security Helpers
 */

const http = require('http');
const https = require('https');
const net = require('net');
const axios = require('axios');
const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { normalizeDigits } = require('./configStore');

// Persistent Keep-Alive HTTP client (reuses TCP/TLS sockets for faster API calls)
const httpClient = axios.create({
    timeout: 10000,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 25 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 25 })
});

const ttlCache = new Map();

function getTtlCached(key) {
    const item = ttlCache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.exp) {
        ttlCache.delete(key);
        return undefined;
    }
    return item.val;
}

function setTtlCached(key, val, ttlMs = 300000) {
    if (ttlCache.size >= 200) {
        const oldest = ttlCache.keys().next().value;
        ttlCache.delete(oldest);
    }
    ttlCache.set(key, { val, exp: Date.now() + ttlMs });
    return val;
}

async function withTtlCache(key, ttlMs, loader) {
    const hit = getTtlCached(key);
    if (hit !== undefined) return hit;
    const val = await loader();
    return setTtlCached(key, val, ttlMs);
}

function clearTtlCache() {
    ttlCache.clear();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, ms = 15000, label = 'Operation') =>
    Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms))
    ]);

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function unwrapMessage(msgObj) {
    let cur = msgObj;
    for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
        if (cur.ephemeralMessage?.message) { cur = cur.ephemeralMessage.message; continue; }
        if (cur.viewOnceMessage?.message) { cur = cur.viewOnceMessage.message; continue; }
        if (cur.viewOnceMessageV2?.message) { cur = cur.viewOnceMessageV2.message; continue; }
        if (cur.viewOnceMessageV2Extension?.message) { cur = cur.viewOnceMessageV2Extension.message; continue; }
        if (cur.deviceSentMessage?.message) { cur = cur.deviceSentMessage.message; continue; }
        if (cur.documentWithCaptionMessage?.message) { cur = cur.documentWithCaptionMessage.message; continue; }
        if (cur.editedMessage?.message) { cur = cur.editedMessage.message; continue; }
        break;
    }
    return cur || null;
}

function getContextInfo(content) {
    if (!content || typeof content !== 'object') return null;
    const type = Object.keys(content)[0];
    return (
        content?.[type]?.contextInfo ||
        content?.extendedTextMessage?.contextInfo ||
        content?.imageMessage?.contextInfo ||
        content?.videoMessage?.contextInfo ||
        content?.documentMessage?.contextInfo ||
        content?.audioMessage?.contextInfo ||
        content?.stickerMessage?.contextInfo ||
        content?.contextInfo ||
        null
    );
}

function getTextFromContent(content) {
    if (!content || typeof content !== 'object') return '';
    return String(
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        content.buttonsResponseMessage?.selectedDisplayText ||
        content.listResponseMessage?.title ||
        ''
    ).trim();
}

async function resolveJidToDigits(sock, jid, altJid = null, groupMeta = null) {
    for (const candidate of [altJid, jid]) {
        if (!candidate) continue;
        const norm = jidNormalizedUser(candidate);
        if (norm.endsWith('@s.whatsapp.net')) {
            return normalizeDigits(norm);
        }
    }

    const lid = jid ? jidNormalizedUser(jid) : '';
    if (lid && groupMeta?.participants) {
        const found = groupMeta.participants.find(
            (p) => p && (p.id === lid || p.lid === lid || normalizeDigits(p.id) === normalizeDigits(lid))
        );
        if (found?.phoneNumber) return normalizeDigits(found.phoneNumber);
        if (found?.id?.endsWith('@s.whatsapp.net')) return normalizeDigits(found.id);
    }

    if (lid && lid.endsWith('@lid') && sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
            if (pn) return normalizeDigits(pn);
        } catch (_) {}
    }

    return normalizeDigits(jid);
}

async function resolveSenderDigits(sock, msg, groupMeta = null) {
    const key = msg?.key || {};
    const isGroup = String(key.remoteJid || '').endsWith('@g.us');
    const senderJid = isGroup ? (key.participant || key.remoteJid) : key.remoteJid;
    const altJid = isGroup
        ? (key.participantAlt || msg.participantPn || key.senderPn)
        : (key.remoteJidAlt || key.participantAlt || key.senderPn);
    return await resolveJidToDigits(sock, senderJid, altJid, groupMeta);
}

function extractTargetJid(msg, args = [], content = null, groupMeta = null) {
    const unwrapped = content || unwrapMessage(msg?.message);
    const ctx = getContextInfo(unwrapped);

    if (ctx?.mentionedJid?.length > 0) {
        return jidNormalizedUser(ctx.mentionedJid[0]);
    }
    if (ctx?.participant) {
        return jidNormalizedUser(ctx.participant);
    }
    for (const a of args) {
        const digits = String(a || '').replace(/[^0-9]/g, '');
        if (digits.length >= 7 && digits.length <= 16) {
            if (groupMeta?.participants) {
                const match = groupMeta.participants.find(
                    (p) => normalizeDigits(p.phoneNumber) === digits || normalizeDigits(p.id) === digits
                );
                if (match?.id) return jidNormalizedUser(match.id);
            }
            return `${digits}@s.whatsapp.net`;
        }
    }
    return null;
}

function isParticipantMatch(p, jid, digits) {
    if (!p) return false;
    const normJ = jid ? jidNormalizedUser(jid) : '';
    const pId = p.id ? jidNormalizedUser(p.id) : '';
    const pLid = p.lid ? jidNormalizedUser(p.lid) : '';
    const pPhone = p.phoneNumber ? normalizeDigits(p.phoneNumber) : '';
    if (normJ && (pId === normJ || pLid === normJ)) return true;
    if (digits && (normalizeDigits(pId) === digits || pPhone === digits)) return true;
    return false;
}

function getGroupAdminState(sock, groupMeta, senderJid, senderDigits) {
    const participants = Array.isArray(groupMeta?.participants) ? groupMeta.participants : [];
    const botPnJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : '';
    const botLidJid = sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : '';
    const botDigits = normalizeDigits(botPnJid);

    const senderPart = participants.find((p) => isParticipantMatch(p, senderJid, senderDigits));
    const botPart = participants.find(
        (p) => isParticipantMatch(p, botPnJid, botDigits) || (botLidJid && isParticipantMatch(p, botLidJid, ''))
    );

    const isAdminRole = (role) => role === 'admin' || role === 'superadmin';
    return {
        isSenderAdmin: Boolean(senderPart && isAdminRole(senderPart.admin)),
        isSenderSuperAdmin: Boolean(senderPart && senderPart.admin === 'superadmin'),
        isBotAdmin: Boolean(botPart && isAdminRole(botPart.admin)),
        participants
    };
}

async function extractMedia(rawContent) {
    const unwrapped = unwrapMessage(rawContent);
    if (!unwrapped) return null;

    const map = {
        imageMessage: 'image',
        videoMessage: 'video',
        audioMessage: 'audio',
        documentMessage: 'document',
        stickerMessage: 'sticker'
    };

    for (const [msgKey, mediaType] of Object.entries(map)) {
        if (unwrapped[msgKey]) {
            const raw = unwrapped[msgKey];
            const stream = await downloadContentFromMessage(raw, mediaType);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return {
                buffer: Buffer.concat(chunks),
                mediaType,
                mimetype: raw.mimetype,
                caption: raw.caption || '',
                fileName: raw.fileName || `file.${mediaType === 'image' ? 'jpg' : mediaType === 'video' ? 'mp4' : 'bin'}`,
                ptt: Boolean(raw.ptt)
            };
        }
    }
    return null;
}

function isPrivateIpOrHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    const ipType = net.isIP(h);
    if (ipType === 4) {
        const parts = h.split('.').map(Number);
        if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] >= 224) return true;
    } else if (ipType === 6) {
        if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    }
    return false;
}

function isSafePublicHttpUrl(urlStr) {
    try {
        const u = new URL(String(urlStr || '').trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (isPrivateIpOrHost(u.hostname)) return null;
        return u.toString();
    } catch (_) {
        return null;
    }
}

async function resolveChannelTarget(sock, targetStr, msg = null) {
    if (!sock) return null;

    // 1. Check forwarded newsletter context from current/quoted message
    if (msg) {
        const unwrapped = unwrapMessage(msg.message);
        const ctx = getContextInfo(unwrapped);
        const fwdInfo = ctx?.forwardedNewsletterMessageInfo;
        if (fwdInfo?.newsletterJid) {
            return {
                jid: fwdInfo.newsletterJid,
                name: fwdInfo.newsletterName || 'WhatsApp Channel',
                postId: fwdInfo.newsletterServerMessageId ? String(fwdInfo.newsletterServerMessageId) : null
            };
        }
        const quoted = unwrapMessage(ctx?.quotedMessage);
        const qCtx = getContextInfo(quoted);
        const qFwd = qCtx?.forwardedNewsletterMessageInfo;
        if (qFwd?.newsletterJid) {
            return {
                jid: qFwd.newsletterJid,
                name: qFwd.newsletterName || 'WhatsApp Channel',
                postId: qFwd.newsletterServerMessageId ? String(qFwd.newsletterServerMessageId) : null
            };
        }
    }

    if (!targetStr) return null;
    const clean = String(targetStr).trim();

    // 2. Invite / Post Link: https://whatsapp.com/channel/CODE[/POST_ID]
    const linkMatch = clean.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)(?:\/(\d+))?/i);
    if (linkMatch) {
        const code = linkMatch[1];
        const postId = linkMatch[2] || null;
        try {
            const meta = await withTimeout(sock.newsletterMetadata('invite', code), 10000, 'Channel lookup');
            if (meta?.id) {
                return {
                    jid: meta.id,
                    name: meta.thread_metadata?.name?.text || meta.name || 'WhatsApp Channel',
                    followers: meta.thread_metadata?.subscribers_count ?? meta.subscribers ?? null,
                    description: meta.thread_metadata?.description?.text || '',
                    role: meta.viewer_metadata?.role || null,
                    inviteCode: code,
                    postId
                };
            }
        } catch (e) {
            throw new Error(`Channel lookup failed: ${e.message}`);
        }
    }

    // 3. Direct @newsletter JID or numeric ID
    let jid = null;
    if (clean.endsWith('@newsletter')) jid = clean;
    else if (/^\d{12,}$/.test(clean)) jid = `${clean}@newsletter`;

    if (jid) {
        let name = 'WhatsApp Channel';
        let followers = null;
        let description = '';
        let role = null;
        try {
            const meta = await withTimeout(sock.newsletterMetadata('jid', jid), 8000, 'Channel JID lookup');
            if (meta) {
                name = meta.thread_metadata?.name?.text || meta.name || name;
                followers = meta.thread_metadata?.subscribers_count ?? meta.subscribers ?? null;
                description = meta.thread_metadata?.description?.text || '';
                role = meta.viewer_metadata?.role || null;
            }
        } catch (_) {}
        return { jid, name, followers, description, role, postId: null };
    }

    return null;
}

async function getSubscribedChannels(sock, adminOnly = false) {
    if (!sock) return [];
    let list = [];
    try {
        if (typeof sock.newsletterSubscribed === 'function') {
            list = await sock.newsletterSubscribed();
        }
    } catch (_) {}

    if (!Array.isArray(list) || list.length === 0) {
        try {
            const res = await withTimeout(sock.query({
                tag: 'iq',
                attrs: { id: sock.generateMessageTag(), type: 'get', to: 's.whatsapp.net', xmlns: 'w:mex' },
                content: [{ tag: 'query', attrs: { query_id: '6388546374527196' }, content: Buffer.from(JSON.stringify({ variables: {} }), 'utf8') }]
            }), 10000, 'Fetch channels');
            const child = Array.isArray(res?.content) ? res.content.find((c) => c?.tag === 'result') : null;
            if (child?.content) {
                const parsed = JSON.parse(Buffer.from(child.content).toString('utf8'));
                list = parsed?.data?.xwa2_newsletter_subscribed || [];
            }
        } catch (_) {}
    }

    return (Array.isArray(list) ? list : [])
        .filter((item) => {
            if (!adminOnly) return true;
            const role = item?.viewer_metadata?.role;
            return role === 'ADMIN' || role === 'OWNER';
        })
        .map((item) => ({
            jid: item.id,
            name: item.thread_metadata?.name?.text || item.name || item.id,
            role: item?.viewer_metadata?.role || 'SUBSCRIBER',
            followers: item?.thread_metadata?.subscribers_count ?? item?.subscribers ?? 0
        }));
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds) {
    const sec = Math.max(0, Math.floor(seconds));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}

module.exports = {
    sleep,
    withTimeout,
    httpClient,
    getTtlCached,
    setTtlCached,
    withTtlCache,
    clearTtlCache,
    escapeHtml,
    unwrapMessage,
    getContextInfo,
    getTextFromContent,
    resolveJidToDigits,
    resolveSenderDigits,
    extractTargetJid,
    getGroupAdminState,
    extractMedia,
    isSafePublicHttpUrl,
    resolveChannelTarget,
    getSubscribedChannels,
    formatBytes,
    formatUptime
};
