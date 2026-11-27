'use strict';

/**
 * ============================================================================
 * SIGMA MD v3.0 :: ULTRA-LOW-RAM 40-SESSION MULTI-TENANT HEROKU WORKER
 * ============================================================================
 * - Baileys v7 (@whiskeysockets/baileys) with @lid <-> @s.whatsapp.net support
 * - Hosts up to 40 concurrent creator-branded & pool sessions per worker server
 * - Bounded Signal key stores + shared ImageKit LRU + periodic GC shield
 * - Platform Master Owner controls + Mandatory .afc / .ajg / .arc enforcement
 * - Verified Referral Webhook strictly on WhatsApp connection === 'open'
 * ============================================================================
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const zlib = require('zlib');
const util = require('util');
const crypto = require('crypto');
const express = require('express');
const gzipAsync = util.promisify(zlib.gzip);
const gunzipAsync = util.promisify(zlib.gunzip);
const pino = require('pino');
const { MongoClient } = require('mongodb');
const {
    default: makeWASocket,
    DEFAULT_CONNECTION_CONFIG,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    areJidsSameUser
} = require('@whiskeysockets/baileys');

const configStore = require('./src/configStore');
const clusterMesh = require('./src/clusterMesh');
const tenantManager = require('./src/tenantManager');
const { installSoundStickerProtoPatch } = require('./src/soundStickerProto');
installSoundStickerProtoPatch();
const registry = require('./src/commands');
const {
    httpClient,
    clearTtlCache,
    escapeHtml,
    unwrapMessage,
    getContextInfo,
    getTextFromContent,
    resolveSenderDigits,
    getGroupAdminState,
    extractMedia,
    formatUptime,
    getMenuImageBuffer,
    warmMenuMedia,
    sleep
} = require('./src/mediaHelper');

const PORT = process.env.PORT || 3000;
const SESSIONS_ROOT = path.join(__dirname, 'sessions');
const LEGACY_SESSION_DIR = path.join(__dirname, 'session');
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const PORTAL_URL = (process.env.PORTAL_URL || process.env.NEXT_PUBLIC_PORTAL_URL || 'https://minibot.site').trim().replace(/\/+$/, '');
const BOOT_TIME = Date.now();

fs.ensureDirSync(SESSIONS_ROOT);

// Global process crash shields
process.on('uncaughtException', (err) => {
    console.error('🛡️ [UncaughtException Guard]:', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🛡️ [UnhandledRejection Guard]:', reason?.stack || reason?.message || reason);
});

const silentLogger = pino({ level: 'fatal' });

/**
 * Bounded LRU Signal Key Cache — prevents NodeCache unbounded growth across 40 sockets
 */
class BoundedSignalCache {
    constructor(maxKeys = 250, ttlMs = 120000) {
        this.maxKeys = maxKeys;
        this.ttlMs = ttlMs;
        this.store = new Map();
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.exp) {
            this.store.delete(key);
            return undefined;
        }
        return entry.val;
    }
    set(key, val) {
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, { val, exp: Date.now() + this.ttlMs });
        while (this.store.size > this.maxKeys) {
            const oldest = this.store.keys().next().value;
            this.store.delete(oldest);
        }
        return true;
    }
    del(key) {
        return this.store.delete(key);
    }
    flushAll() {
        this.store.clear();
    }
}

// Multi-Session Registry (phone -> sessionState)
const sessions = new Map();
const pairLocks = new Map();

let cachedBaileysVersion = Array.isArray(DEFAULT_CONNECTION_CONFIG?.version) ? DEFAULT_CONNECTION_CONFIG.version : [2, 3000, 1043857760];
let versionRefreshStarted = false;

let mongoClient = null;
let mongoDb = null;
let mongoConnecting = false;

// Shared Bounded Caches across all worker sessions
const messageStore = new Map();
const processedMsgIds = new Set();
const antideleteCache = new Map();
const groupMetaCache = new Map();
const inFlightGroupMeta = new Map();
const GROUP_META_TTL_MS = 5 * 60 * 1000;

function capSet(set, key, max = 1000) {
    set.add(key);
    if (set.size > max) {
        const first = set.values().next().value;
        set.delete(first);
    }
}

function capMap(map, key, val, max = 400) {
    map.set(key, val);
    if (map.size > max) {
        const first = map.keys().next().value;
        map.delete(first);
    }
}

function cacheMessage(msg) {
    if (!msg?.key?.id || !msg?.message) return;
    const id = msg.key.id;
    capMap(messageStore, id, msg.message, 400);
    if (msg.key.remoteJid) {
        capMap(messageStore, `${msg.key.remoteJid}:${id}`, msg.message, 400);
    }
}

async function getCachedGroupMeta(sock, jid) {
    if (!jid || !sock) return null;
    const hit = groupMetaCache.get(jid);
    if (hit && Date.now() - hit.ts < GROUP_META_TTL_MS) return hit.meta;
    if (inFlightGroupMeta.has(jid)) return inFlightGroupMeta.get(jid);

    const p = (async () => {
        try {
            const meta = await sock.groupMetadata(jid);
            capMap(groupMetaCache, jid, { ts: Date.now(), meta }, 80);
            return meta;
        } catch (_) {
            return hit?.meta || null;
        } finally {
            inFlightGroupMeta.delete(jid);
        }
    })();
    inFlightGroupMeta.set(jid, p);
    return p;
}

function getMemoryUsageMb() {
    return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function getUptimeSec() {
    return Math.floor((Date.now() - BOOT_TIME) / 1000);
}

function getOpenSockets() {
    const out = [];
    for (const s of sessions.values()) {
        if (s?.sock && s.isConnected) out.push(s.sock);
    }
    return out;
}

function getPrimarySock() {
    for (const s of sessions.values()) {
        if (s?.sock && s.isConnected && tenantManager.isMasterOwner(s.cachedBotDigits || s.id)) {
            return s.sock;
        }
    }
    for (const s of sessions.values()) {
        if (s?.sock && s.isConnected) return s.sock;
    }
    for (const s of sessions.values()) {
        if (s?.sock) return s.sock;
    }
    return null;
}

function getConnectedCount() {
    let count = 0;
    for (const s of sessions.values()) {
        if (s?.isConnected) count++;
    }
    return count;
}

function getConnectingCount() {
    let count = 0;
    for (const s of sessions.values()) {
        if (s?.isConnecting) count++;
    }
    return count;
}

function isAcceptingNewPairs() {
    return getConnectedCount() < tenantManager.MAX_SESSIONS && getMemoryUsageMb() < tenantManager.RAM_SOFT_LIMIT_MB;
}

function trimCaches() {
    if (messageStore.size > 300) {
        const excess = messageStore.size - 300;
        let i = 0;
        for (const k of messageStore.keys()) {
            messageStore.delete(k);
            if (++i >= excess) break;
        }
    }
    if (antideleteCache.size > 120) antideleteCache.clear();
    if (groupMetaCache.size > 50) groupMetaCache.clear();
    if (processedMsgIds.size > 800) processedMsgIds.clear();
    clearTtlCache();
}

// ═════════════════════════════════════════════════════════════
// 1. MONGODB ATLAS LEAN AUTH BACKUP & MULTI-SESSION RECOVERY
// ═════════════════════════════════════════════════════════════

function resetMongoOnError(err) {
    const m = String(err?.message || err || '');
    if (/SSL|TLS|topology|closed|network|ECONNRESET|ETIMEDOUT|pool|alert/i.test(m)) {
        mongoDb = null;
        try { mongoClient?.close?.(); } catch (_) {}
        mongoClient = null;
    }
}

async function initMongo() {
    if (!MONGODB_URI) return null;
    if (mongoDb) return mongoDb;
    if (mongoConnecting) return null;
    mongoConnecting = true;
    try {
        mongoClient = new MongoClient(MONGODB_URI, {
            serverSelectionTimeoutMS: 8000,
            maxPoolSize: 5
        });
        await mongoClient.connect();
        mongoDb = mongoClient.db('mr_saqib_bot');
        console.log('✅ [MongoDB] Connected to Atlas Cloud.');
        return mongoDb;
    } catch (e) {
        console.warn('⚠️ [MongoDB Warning]:', e.message);
        resetMongoOnError(e);
        return null;
    } finally {
        mongoConnecting = false;
    }
}

configStore.setMongoGetter(initMongo);

function filterLeanSessionFiles(filenames) {
    const creds = filenames.filter((f) => f === 'creds.json');
    const appState = filenames.filter((f) => f.startsWith('app-state-sync-key-'));
    const preKeys = filenames
        .filter((f) => f.startsWith('pre-key-'))
        .sort((a, b) => (parseInt(b.replace(/\D/g, ''), 10) || 0) - (parseInt(a.replace(/\D/g, ''), 10) || 0))
        .slice(0, 45);
    const senderKeys = filenames.filter((f) => f.startsWith('sender-key-') && !f.startsWith('sender-key-memory-')).slice(0, 90);
    const chatSessions = filenames.filter((f) => f.startsWith('session-')).slice(0, 90);
    const identityKeys = filenames.filter((f) => f.startsWith('identity-')).slice(0, 45);

    return new Set([...creds, ...appState, ...preKeys, ...senderKeys, ...chatSessions, ...identityKeys]);
}

function isRegisteredCredsJson(rawStr) {
    try {
        const parsed = JSON.parse(String(rawStr || '{}'));
        return Boolean(parsed && parsed.registered === true && parsed.me?.id);
    } catch (_) {
        return false;
    }
}

function getSessionDocId(sessionKey) {
    return sessionKey === 'primary' ? 'primary_session' : `sess_${sessionKey}`;
}

async function executeSessionCloudBackup(session) {
    if (!MONGODB_URI || !session || session.backupInFlight) return false;
    session.backupInFlight = true;
    try {
        const credsFile = path.join(session.authDir, 'creds.json');
        if (!fs.existsSync(credsFile)) return false;
        const rawCreds = await fs.readFile(credsFile, 'utf8').catch(() => '');
        if (!isRegisteredCredsJson(rawCreds)) return false;

        const allFiles = await fs.readdir(session.authDir);
        const leanSet = filterLeanSessionFiles(allFiles);
        const filesMap = {};
        await Promise.all(Array.from(leanSet).map(async (f) => {
            const fp = path.join(session.authDir, f);
            const stat = await fs.stat(fp).catch(() => null);
            if (stat?.isFile()) {
                filesMap[f] = await fs.readFile(fp, 'utf8');
            }
        }));
        if (!filesMap['creds.json']) return false;

        const payloadBuf = Buffer.from(JSON.stringify(filesMap), 'utf8');
        const currentHash = crypto.createHash('sha1').update(payloadBuf).digest('hex');
        if (currentHash === session.lastBackupHash) return true;

        const compressed = await gzipAsync(payloadBuf);
        const db = await initMongo();
        if (!db) return false;

        const workerId = tenantManager.getWorkerId();
        const docId = getSessionDocId(session.id);
        await db.collection('mini_bot_auth').updateOne(
            { _id: docId },
            {
                $set: {
                    _id: docId,
                    sessionKey: session.id,
                    workerId,
                    data: compressed,
                    fileCount: Object.keys(filesMap).length,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        session.lastBackupHash = currentHash;
        return true;
    } catch (e) {
        console.warn(`⚠️ [Backup Error ${session?.id}]:`, e.message);
        resetMongoOnError(e);
        return false;
    } finally {
        session.backupInFlight = false;
    }
}

function scheduleSessionBackup(session) {
    if (!MONGODB_URI || !session) return;
    if (session.backupDebounceTimer) clearTimeout(session.backupDebounceTimer);
    session.backupDebounceTimer = setTimeout(() => {
        executeSessionCloudBackup(session).catch(() => {});
    }, 20000);
}

async function restoreAllSessionsFromCloud() {
    try {
        const db = await initMongo();
        if (!db) return [];

        const workerId = tenantManager.getWorkerId();
        const docs = await db.collection('mini_bot_auth')
            .find({
                $or: [
                    { _id: 'primary_session' },
                    { workerId },
                    { workerId: { $exists: false } }
                ]
            })
            .limit(tenantManager.MAX_SESSIONS)
            .toArray();

        const restoredKeys = [];
        for (const doc of docs) {
            if (!doc?.data) continue;
            try {
                let buffer;
                if (Buffer.isBuffer(doc.data)) buffer = doc.data;
                else if (doc.data?.buffer) buffer = Buffer.from(doc.data.buffer);
                else buffer = Buffer.from(doc.data, 'base64');

                const rawMapBuf = await gunzipAsync(buffer);
                const filesMap = JSON.parse(rawMapBuf.toString('utf8'));
                if (!filesMap['creds.json'] || !isRegisteredCredsJson(filesMap['creds.json'])) continue;

                const credsParsed = JSON.parse(filesMap['creds.json']);
                const derivedPhone = configStore.normalizeDigits(credsParsed?.me?.id);
                const sKey = doc.sessionKey || derivedPhone || (doc._id === 'primary_session' ? 'primary' : String(doc._id).replace(/^sess_/, ''));
                if (!sKey) continue;

                const sDir = path.join(SESSIONS_ROOT, sKey);
                const localCreds = path.join(sDir, 'creds.json');
                if (fs.existsSync(localCreds)) {
                    const localRaw = await fs.readFile(localCreds, 'utf8').catch(() => '');
                    if (isRegisteredCredsJson(localRaw)) {
                        restoredKeys.push(sKey);
                        continue;
                    }
                }

                await fs.ensureDir(sDir);
                for (const [filename, content] of Object.entries(filesMap)) {
                    const safeName = path.basename(filename);
                    await fs.writeFile(path.join(sDir, safeName), String(content), 'utf8');
                }
                restoredKeys.push(sKey);
            } catch (_) {}
        }
        return restoredKeys;
    } catch (e) {
        console.warn('⚠️ [Cloud Restore Warning]:', e.message);
        resetMongoOnError(e);
        return [];
    }
}

async function migrateLegacyPrimaryDirIfNeeded() {
    try {
        const legacyCreds = path.join(LEGACY_SESSION_DIR, 'creds.json');
        if (!fs.existsSync(legacyCreds)) return;
        const raw = await fs.readFile(legacyCreds, 'utf8').catch(() => '');
        if (!isRegisteredCredsJson(raw)) return;
        const parsed = JSON.parse(raw);
        const phoneKey = configStore.normalizeDigits(parsed?.me?.id) || 'primary';
        const targetDir = path.join(SESSIONS_ROOT, phoneKey);
        if (!fs.existsSync(path.join(targetDir, 'creds.json'))) {
            await fs.copy(LEGACY_SESSION_DIR, targetDir, { overwrite: false });
            console.log(`📦 [Migration] Moved legacy primary session -> sessions/${phoneKey}`);
        }
    } catch (_) {}
}

// ═════════════════════════════════════════════════════════════
// 2. MULTI-TENANT BAILEYS v7 SESSION ENGINE (UP TO 40 / DYNO)
// ═════════════════════════════════════════════════════════════

function cleanupSessionSocket(session) {
    if (!session) return;
    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }
    if (session.sock) {
        try { session.sock.ev.removeAllListeners(); } catch (_) {}
        try { session.sock.ws?.close?.(); } catch (_) {}
        try { session.sock.ws?.socket?.terminate?.(); } catch (_) {}
        session.sock = null;
    }
}

async function destroySessionCompletely(sessionKey) {
    const cleanKey = configStore.normalizeDigits(sessionKey) || String(sessionKey || '').trim();
    const s = sessions.get(cleanKey);
    if (s) {
        cleanupSessionSocket(s);
        if (s.backupDebounceTimer) clearTimeout(s.backupDebounceTimer);
        sessions.delete(cleanKey);
    }
    const dir = path.join(SESSIONS_ROOT, cleanKey);
    await fs.remove(dir).catch(() => {});
    tenantManager.removeSessionMeta(cleanKey);
    if (MONGODB_URI) {
        const db = await initMongo().catch(() => null);
        await db?.collection('mini_bot_auth')?.deleteOne({ _id: getSessionDocId(cleanKey) }).catch(() => {});
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const compiledPrefixCache = new Map();
function getPrefixRegex(activePrefix) {
    let re = compiledPrefixCache.get(activePrefix);
    if (re) return re;
    re = new RegExp(`^(${escapeRegExp(activePrefix)})\\s*([a-zA-Z0-9_-]+)([\\s\\S]*)$`);
    if (compiledPrefixCache.size > 20) compiledPrefixCache.clear();
    compiledPrefixCache.set(activePrefix, re);
    return re;
}

async function handleIncomingForSession(session, msg) {
    try {
        if (!msg?.message || !msg.key) return;
        const msgId = msg.key.id;
        const uniqueMsgKey = `${session.id}:${msgId || Date.now()}`;
        if (msgId && processedMsgIds.has(uniqueMsgKey)) return;
        if (msgId) capSet(processedMsgIds, uniqueMsgKey, 1000);

        const sock = session.sock;
        if (!sock) return;

        const sessionCfg = tenantManager.resolveSessionEffectiveConfig(session.id);
        if (sessionCfg.antidelete) cacheMessage(msg);

        if (msg.key.remoteJid === 'status@broadcast') {
            if (sessionCfg.autoviewStatus && !msg.key.fromMe) {
                sock.readMessages([msg.key]).catch(() => {});
            }
            if (!msg.message?.deviceSentMessage?.destinationJid) return;
        }

        if (msg.key.remoteJid?.endsWith('@newsletter')) {
            const chJid = msg.key.remoteJid;
            const msgTime = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();
            const postAgeMs = Date.now() - msgTime;
            if (postAgeMs < -30000 || postAgeMs > 120000) return;

            const arcMap = tenantManager.getPlatformMandatoryArcMap();
            const arcConf = arcMap[chJid] || Object.values(arcMap).find((c) => c?.jid === chJid);
            const serverId = msg.key?.server_id || msg.messageServerId || msg.newsletterServerId || msg.key?.serverId || msg.attrs?.server_id;
            if (arcConf && arcConf.enabled !== false && serverId) {
                clusterMesh.executeMiniArcReaction(sock, chJid, serverId, arcConf).catch(() => {});
            }
            return;
        }

        const protoMsg = msg.message?.protocolMessage;
        if (protoMsg?.type === 0 && sessionCfg.antidelete) {
            const revokedId = protoMsg.key?.id;
            const cached = revokedId ? antideleteCache.get(`${session.id}:${revokedId}`) : null;
            const botPn = session.cachedBotPn || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
            if (cached && botPn) {
                await sock.sendMessage(botPn, {
                    text: `🛡️ *ANTI-DELETE RECOVERED*\n👤 *From:* ${cached.chat}\n📱 *Sender:* +${cached.sender}\n\n📝 *Message:*\n${cached.text || '[Media / Non-Text]'}`
                }).catch(() => {});
            }
            return;
        }

        const botPn = session.cachedBotPn || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
        const botLid = session.cachedBotLid || (sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : null);
        const botDigits = session.cachedBotDigits || configStore.normalizeDigits(botPn);

        let rawFrom = msg.key.remoteJid;
        if ((!rawFrom || rawFrom === 'status@broadcast') && msg.message?.deviceSentMessage?.destinationJid) {
            rawFrom = msg.message.deviceSentMessage.destinationJid;
        }
        if (!rawFrom || rawFrom === 'status@broadcast') rawFrom = botPn;
        if (!rawFrom) return;

        let from = jidNormalizedUser(rawFrom);
        const isFromMe = Boolean(msg.key.fromMe);
        const isGroup = from.endsWith('@g.us');

        const isSelfChat = isFromMe && (
            from === botPn ||
            from === botLid ||
            areJidsSameUser(from, botPn) ||
            (botLid && areJidsSameUser(from, botLid))
        );

        if (isSelfChat && botPn) {
            from = botPn;
        } else if (from.endsWith('@lid')) {
            const alt = msg.key.remoteJidAlt || msg.key.participantAlt;
            if (alt && alt.endsWith('@s.whatsapp.net')) from = jidNormalizedUser(alt);
        }

        const rawRoot = msg.message;
        const isViewOnceMsg = Boolean(
            rawRoot.viewOnceMessage || rawRoot.viewOnceMessageV2 || rawRoot.viewOnceMessageV2Extension
        );
        if (sessionCfg.autovv && isViewOnceMsg && !isFromMe && botPn) {
            extractMedia(rawRoot).then(async (voMedia) => {
                if (!voMedia) return;
                const voCap = `🔓 *AUTO VIEW-ONCE*\n👤 *From:* +${msg.key.participant?.split('@')[0] || from.split('@')[0] || 'Unknown'}`;
                if (voMedia.mediaType === 'image') await sock.sendMessage(botPn, { image: voMedia.buffer, caption: voCap });
                else if (voMedia.mediaType === 'video') await sock.sendMessage(botPn, { video: voMedia.buffer, caption: voCap });
                else if (voMedia.mediaType === 'audio') await sock.sendMessage(botPn, { audio: voMedia.buffer, mimetype: voMedia.mimetype || 'audio/mp4', ptt: voMedia.ptt });
            }).catch(() => {});
        }

        const content = unwrapMessage(rawRoot);
        if (!content) return;
        const rawText = getTextFromContent(content);
        const cleanText = (rawText || '').replace(/[\u200e\u200f\u200b\u200c\u200d\u2060\ufeff]/g, '').trim();
        const activePrefix = sessionCfg.prefix || '.';
        const match = cleanText ? cleanText.match(getPrefixRegex(activePrefix)) : null;

        if (sessionCfg.autoreact && !isFromMe && !match && rawRoot && !rawRoot.protocolMessage && !rawRoot.reactionMessage) {
            const reactPool = ['❤️', '🔥', '👍', '👏', '✨', '⚡', '😍', '🎉'];
            const pickedEmoji = reactPool[Math.floor(Math.random() * reactPool.length)];
            sock.sendMessage(from, { react: { text: pickedEmoji, key: msg.key } }).catch(() => {});
        }

        if (!rawText) return;

        const gs = isGroup ? configStore.getGroupSettings(from) : null;
        const hasLinkViolation = Boolean(
            isGroup && gs?.antilink && !isFromMe && /(https?:\/\/)?(chat\.whatsapp\.com|whatsapp\.com\/channel)\/\S+/i.test(rawText)
        );

        if (sessionCfg.antidelete && msgId && !isFromMe) {
            capMap(antideleteCache, `${session.id}:${msgId}`, {
                chat: from,
                sender: msg.key.participant?.split('@')[0] || from.split('@')[0],
                text: rawText
            }, 150);
        }

        if (!match && !hasLinkViolation) return;

        const cmd = match ? registry.findCommand(match[2].toLowerCase()) : null;
        if (!cmd && !hasLinkViolation) return;

        const msgTime = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();
        if (Date.now() - msgTime > 120000) return;

        const senderRawJid = isGroup ? (msg.key.participant || from) : from;
        const altPn = isGroup ? (msg.key.participantAlt || msg.participantPn) : (msg.key.remoteJidAlt || msg.participantAlt);
        const needsGroupMeta = isGroup && (hasLinkViolation || cmd?.category === 'group' || (senderRawJid.endsWith('@lid') && !altPn?.endsWith('@s.whatsapp.net')));
        const groupMeta = needsGroupMeta ? await getCachedGroupMeta(sock, from) : null;

        let senderDigits = '';
        if (isFromMe && botDigits) {
            senderDigits = botDigits;
        } else if (!isGroup && from.endsWith('@s.whatsapp.net')) {
            senderDigits = configStore.normalizeDigits(from);
        } else {
            senderDigits = await resolveSenderDigits(sock, msg, groupMeta);
        }

        const isMasterOwner = isFromMe ? tenantManager.isMasterOwner(botDigits) : tenantManager.isMasterOwner(senderDigits);
        const isOwner = isFromMe || isMasterOwner || tenantManager.isSessionOwner(session.id, senderDigits, botDigits);

        if (hasLinkViolation && !isOwner) {
            const adminState = getGroupAdminState(sock, groupMeta, senderRawJid, senderDigits);
            if (!adminState.isSenderAdmin && adminState.isBotAdmin) {
                sock.sendMessage(from, { delete: msg.key }).catch(() => {});
                const warns = configStore.addWarning(from, senderDigits);
                if (warns >= 3) {
                    configStore.resetWarnings(from, senderDigits);
                    sock.groupParticipantsUpdate(from, [senderRawJid], 'remove').catch(() => {});
                    sock.sendMessage(from, { text: `🚨 *ANTI-LINK:* @${senderRawJid.split('@')[0]} 3/3 warnings par remove ho gaye!`, mentions: [senderRawJid] }).catch(() => {});
                } else {
                    sock.sendMessage(from, { text: `🔗 *ANTI-LINK:* @${senderRawJid.split('@')[0]} group mein link allow nahi! (Warning *${warns}/3*)`, mentions: [senderRawJid] }).catch(() => {});
                }
                return;
            }
        }

        if (!cmd) return;
        if (sessionCfg.mode !== 'public' && !isOwner) return;
        if (!isOwner && configStore.isBannedDigits(senderDigits)) return;

        if (sessionCfg.autoread && !isFromMe) sock.readMessages([msg.key]).catch(() => {});
        if (sessionCfg.autotyping) sock.sendPresenceUpdate('composing', from).catch(() => {});
        else if (sessionCfg.autorecord) sock.sendPresenceUpdate('recording', from).catch(() => {});

        const mCtx = getContextInfo(content);
        const quotedMsg = mCtx?.quotedMessage || null;
        const commandName = match[2].toLowerCase();
        const fullArgs = (match[3] || '').trim();
        const args = fullArgs ? fullArgs.split(/\s+/).filter(Boolean) : [];
        const quoteOpt = isGroup ? { quoted: msg } : {};

        const ctx = {
            sock,
            from,
            msg,
            content,
            quotedMsg,
            isGroup,
            isSelfChat,
            isFromMe,
            isOwner,
            isMasterOwner,
            tenantConfig: sessionCfg,
            groupMeta,
            senderRawJid,
            senderDigits,
            prefix: activePrefix,
            commandName,
            args,
            fullArgs,
            msgTime,
            quoteOpt,
            cacheMessage,
            registry,
            runtime: {
                getMemoryUsageMb,
                getUptimeSec,
                trimCaches,
                activeSessionsCount: getConnectedCount,
                maxSessions: tenantManager.MAX_SESSIONS,
                forceCloudBackup: () => executeSessionCloudBackup(session)
            },
            reply: (text) => sock.sendMessage(from, { text }, quoteOpt),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {})
        };

        try {
            await cmd.handler(ctx);
        } catch (execErr) {
            console.error(`❌ [CMD ${commandName} | ${session.id}]:`, execErr.message);
            ctx.react('❌');
            await ctx.reply(`❌ *Error (${commandName}):* ${execErr.message}`).catch(() => {});
        }
    } catch (loopErr) {
        console.error('❌ [Message Handler Error]:', loopErr.message);
    }
}

async function initSession(sessionKey, pairingNumber = null, opts = {}) {
    const cleanKey = configStore.normalizeDigits(sessionKey) || String(sessionKey || 'primary').trim();
    const isFreshPairing = Boolean(pairingNumber || opts.isFreshPairing);

    let session = sessions.get(cleanKey);
    if (session?.isConnecting) {
        if (Date.now() - session.connectStartedAt < 45000) {
            return session.currentPairingCode;
        }
        session.isConnecting = false;
    }

    if (!session) {
        session = {
            id: cleanKey,
            authDir: path.join(SESSIONS_ROOT, cleanKey),
            sock: null,
            isConnected: false,
            isConnecting: false,
            connectStartedAt: 0,
            reconnectTimer: null,
            consecutive401Count: 0,
            currentPairingCode: null,
            cachedBotPn: null,
            cachedBotLid: null,
            cachedBotDigits: '',
            isFreshPairing,
            backupDebounceTimer: null,
            backupInFlight: false,
            lastBackupHash: ''
        };
        sessions.set(cleanKey, session);
    } else if (isFreshPairing) {
        session.isFreshPairing = true;
    }

    session.isConnecting = true;
    session.connectStartedAt = Date.now();
    session.currentPairingCode = null;

    try {
        cleanupSessionSocket(session);
        await fs.ensureDir(session.authDir);

        const { state, saveCreds } = await useMultiFileAuthState(session.authDir);
        const boundedSignalCache = new BoundedSignalCache(250, 120000);

        const originalKeysSet = state.keys.set;
        state.keys.set = async (data) => {
            await originalKeysSet(data);
            scheduleSessionBackup(session);
        };

        if (!versionRefreshStarted) {
            versionRefreshStarted = true;
            fetchLatestBaileysVersion()
                .then((fetched) => {
                    if (Array.isArray(fetched?.version)) cachedBaileysVersion = fetched.version;
                })
                .catch(() => {});
        }

        console.log(`🚀 [Baileys] Booting session "${session.id}" (WA v${cachedBaileysVersion.join('.')})...`);

        const sock = makeWASocket({
            version: cachedBaileysVersion,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, silentLogger, boundedSignalCache)
            },
            printQRInTerminal: false,
            logger: silentLogger,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            fireInitQueries: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 25000,
            defaultQueryTimeoutMs: 20000,
            emitOwnEvents: true,
            retryRequestDelayMs: 600,
            maxMsgRetryCount: 4,
            generateHighQualityLinkPreview: false,
            cachedGroupMetadata: async (jid) => getCachedGroupMeta(session.sock, jid),
            getMessage: async (key) => {
                if (!key || key.remoteJid?.endsWith('@newsletter')) return undefined;
                if (key.id && messageStore.has(key.id)) return messageStore.get(key.id);
                if (key.remoteJid && key.id && messageStore.has(`${key.remoteJid}:${key.id}`)) {
                    return messageStore.get(`${key.remoteJid}:${key.id}`);
                }
                return undefined;
            }
        });

        session.sock = sock;

        // Safe-Send wrapper with multi-tenant View Channel + explicit Card 2 skipChannelCard support
        const rawSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options = {}) => {
            const botPn = session.cachedBotPn || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
            const botLid = session.cachedBotLid || (sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : null);
            let targetJid = jid ? jidNormalizedUser(jid) : null;

            if (targetJid && !targetJid.endsWith('@g.us') && !targetJid.endsWith('@newsletter')) {
                if (
                    (botLid && (targetJid === botLid || areJidsSameUser(targetJid, botLid))) ||
                    (botPn && areJidsSameUser(targetJid, botPn))
                ) {
                    targetJid = botPn;
                    jid = botPn;
                }
            }

            const isSelf = Boolean(botPn && targetJid && (botPn === targetJid || areJidsSameUser(botPn, targetJid)));
            if (options?.quoted && (options.quoted.key?.fromMe || isSelf)) {
                options = { ...options };
                delete options.quoted;
            }

            const sessionCfg = tenantManager.resolveSessionEffectiveConfig(session.id);
            const isSkipCard = Boolean(content && typeof content === 'object' && content.skipChannelCard);
            if (isSkipCard) {
                content = { ...content };
                delete content.skipChannelCard;
            }

            const isNewsletterDest = targetJid && targetJid.endsWith('@newsletter');
            const isStatusDest = targetJid === 'status@broadcast';
            const supportsChannelCard = Boolean(
                !isSkipCard &&
                content &&
                typeof content === 'object' &&
                !content.react &&
                !content.delete &&
                !content.poll &&
                !content.edit &&
                (content.text !== undefined || content.image || content.video || content.audio || content.document)
            );
            if (sessionCfg.channelCardEnabled && sessionCfg.newsletterJid && !isNewsletterDest && !isStatusDest && supportsChannelCard) {
                const existingCtx = (content.contextInfo && typeof content.contextInfo === 'object') ? content.contextInfo : {};
                content = {
                    ...content,
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: sessionCfg.newsletterJid,
                            newsletterName: sessionCfg.newsletterName || sessionCfg.botName || 'SIGMA MD',
                            serverMessageId: 1
                        },
                        ...existingCtx
                    }
                };
            }

            const sentMsg = await rawSendMessage(jid, content, options);
            if (sessionCfg.antidelete) cacheMessage(sentMsg);
            return sentMsg;
        };

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                scheduleSessionBackup(session);
            } catch (_) {}
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
                session.isConnected = false;
                session.isConnecting = false;
                session.cachedBotPn = null;
                session.cachedBotLid = null;
                session.cachedBotDigits = '';

                console.log(`⚠️ [Session ${session.id} Closed] Status: ${statusCode || 'unknown'}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    session.consecutive401Count++;
                    if (session.consecutive401Count < 3 && fs.existsSync(path.join(session.authDir, 'creds.json'))) {
                        console.warn(`🛡️ [401 Shield ${session.id}] Transient #${session.consecutive401Count}/3 — retrying...`);
                        session.reconnectTimer = setTimeout(() => initSession(session.id).catch(() => {}), session.consecutive401Count * 5000);
                        return;
                    }
                    console.log(`🔴 [LoggedOut ${session.id}] Session revoked. Cleaning up...`);
                    await destroySessionCompletely(session.id);
                } else {
                    session.consecutive401Count = 0;
                    const waitMs = statusCode === DisconnectReason.restartRequired ? 1500 : 5000;
                    session.reconnectTimer = setTimeout(() => initSession(session.id).catch(() => {}), waitMs);
                }
            } else if (connection === 'open') {
                session.isConnected = true;
                session.isConnecting = false;
                session.consecutive401Count = 0;
                session.currentPairingCode = null;

                session.cachedBotPn = jidNormalizedUser(sock.user.id);
                session.cachedBotLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
                session.cachedBotDigits = configStore.normalizeDigits(session.cachedBotPn);
                const botJid = session.cachedBotPn;

                // Canonicalize key by real WhatsApp digits if booted under legacy 'primary'
                if (session.cachedBotDigits && session.id !== session.cachedBotDigits) {
                    const prevOther = sessions.get(session.cachedBotDigits);
                    if (prevOther && prevOther !== session) cleanupSessionSocket(prevOther);
                    const oldId = session.id;
                    session.id = session.cachedBotDigits;
                    sessions.delete(oldId);
                    sessions.set(session.cachedBotDigits, session);
                }

                const meta = tenantManager.getSessionMeta(session.id);
                if (meta?.creatorId) {
                    await tenantManager.fetchCreatorConfigFromSupabase(meta.creatorId).catch(() => {});
                }
                const sessionCfg = tenantManager.resolveSessionEffectiveConfig(session.id);
                const totalCmds = registry.getAllCommands().length;

                console.log(`🟢 [CONNECTED ${session.id}] ${sessionCfg.botName} ONLINE (${getConnectedCount()}/${tenantManager.MAX_SESSIONS} active | RAM ${getMemoryUsageMb()}MB)`);

                // Send startup confirmation cleanly
                try {
                    await sock.sendMessage(botJid, {
                        text: `╭━━━〔 ⚡ *${sessionCfg.botName} ONLINE* ⚡ 〕━━━┈⊷\n` +
                              `┃ 🟢 *Status:* Connected (Baileys v7)\n` +
                              `┃ 👑 *Owner:* ${sessionCfg.ownerName}\n` +
                              `┃ 🛠️ *Commands:* ${totalCmds}+ Loaded\n` +
                              `┃ 💾 *Worker RAM:* ${getMemoryUsageMb()} MB / 512 MB\n` +
                              `┃ 🌐 *Slots Active:* ${getConnectedCount()} / ${tenantManager.MAX_SESSIONS}\n` +
                              `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                              `_Type *${sessionCfg.prefix}menu* ya *${sessionCfg.prefix}profile* to explore!_`
                    });
                } catch (_) {}

                // Notify Portal STRICTLY on real WhatsApp connection === 'open' (referral & active slot sync)
                tenantManager.notifyPortalReferralVerified({
                    phone: session.cachedBotDigits || session.id,
                    refCode: meta?.pendingReferral || null,
                    source: 'mini',
                    workerNodeId: tenantManager.getWorkerId(),
                    creatorId: meta?.creatorId || null
                }).catch(() => {});

                scheduleSessionBackup(session);

                // Warm menu art for primary or small pools
                if (getConnectedCount() <= 8) {
                    setTimeout(() => { warmMenuMedia(sock).catch(() => {}); }, 2500);
                }

                // Mandatory Platform .afc + Creator Channel + .ajg run ONLY on fresh interactive pairing
                const shouldRunFreshAutomations = Boolean(session.isFreshPairing);
                session.isFreshPairing = false;
                if (shouldRunFreshAutomations) {
                    setTimeout(async () => {
                        const afcList = tenantManager.getPlatformMandatoryChannels();
                        if (sessionCfg.newsletterJid && !afcList.some((c) => c.jid === sessionCfg.newsletterJid)) {
                            afcList.push({ jid: sessionCfg.newsletterJid, name: sessionCfg.botName });
                        }
                        for (const ch of afcList) {
                            try {
                                await sock?.newsletterFollow?.(ch.jid);
                                await sleep(700);
                            } catch (_) {}
                        }
                        for (const g of tenantManager.getPlatformMandatoryGroups()) {
                            try {
                                if (g?.code && typeof sock?.groupAcceptInvite === 'function') {
                                    await sock.groupAcceptInvite(g.code);
                                }
                                await sleep(1000);
                            } catch (_) {}
                        }
                    }, 9000);
                }

                setTimeout(() => {
                    if (session.isConnected) {
                        clusterMesh.syncAllNewsletterSubscriptions(sock).catch(() => {});
                    }
                }, 13000);

                const selfUrl = clusterMesh.getSelfUrl();
                if (selfUrl) {
                    setTimeout(() => {
                        clusterMesh.broadcastToAllClusters('register_mini_node', { url: selfUrl }).catch(() => {});
                    }, 8000);
                }
            }
        });

        sock.ev.on('call', async (calls) => {
            const sessionCfg = tenantManager.resolveSessionEffectiveConfig(session.id);
            if (!sessionCfg.anticall || !Array.isArray(calls)) return;
            for (const call of calls) {
                if (call?.status !== 'offer' || !call?.id || !call?.from) continue;
                await sock.rejectCall(call.id, call.from).catch(() => {});
            }
        });

        sock.ev.on('groups.update', (updates) => {
            if (!Array.isArray(updates)) return;
            for (const u of updates) {
                if (u?.id) groupMetaCache.delete(u.id);
            }
        });

        sock.ev.on('group-participants.update', async (ev) => {
            try {
                const { id: groupJid, participants, action } = ev || {};
                if (groupJid) groupMetaCache.delete(groupJid);
                if (!groupJid || !Array.isArray(participants) || !['add', 'remove'].includes(action)) return;
                const gs = configStore.getGroupSettings(groupJid);
                if (action === 'add' && !gs.welcome) return;
                if (action === 'remove' && !gs.goodbye) return;

                const meta = await getCachedGroupMeta(sock, groupJid);
                const groupName = meta?.subject || 'this group';
                for (const rawParticipant of participants) {
                    const pJid = typeof rawParticipant === 'string' ? rawParticipant : rawParticipant?.id;
                    if (!pJid) continue;
                    const tag = `@${pJid.split('@')[0]}`;
                    const template = action === 'add'
                        ? (gs.welcomeText || `👋 Khush Amdeed ${tag} in *${groupName}*!`)
                        : (gs.goodbyeText || `👋 Allah Hafiz ${tag}!`);
                    await sock.sendMessage(groupJid, { text: template, mentions: [pJid] }).catch(() => {});
                }
            } catch (_) {}
        });

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify' || !Array.isArray(messages) || messages.length === 0) return;
            for (const msg of messages) {
                void handleIncomingForSession(session, msg);
            }
        });

        if (pairingNumber && !sock.authState.creds.registered) {
            const clean = pairingNumber.replace(/[^0-9]/g, '');
            await sleep(500);
            const code = await sock.requestPairingCode(clean);
            session.currentPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`🔑 [Pairing Code ${clean}] => ${session.currentPairingCode}`);
            session.isConnecting = false;
            return session.currentPairingCode;
        }

        session.isConnecting = false;
        return null;
    } catch (err) {
        session.isConnecting = false;
        console.error(`❌ [Init Error ${cleanKey}]:`, err.message);
        throw err;
    }
}

// ═════════════════════════════════════════════════════════════
// 3. 24/7 KEEPALIVE, NEWSLETTER LEASE, GC & HEARTBEAT ENGINE
// ═════════════════════════════════════════════════════════════

async function pingPublicKeepAlive() {
    try {
        const myUrl = clusterMesh.getSelfUrl() ||
            process.env.APP_URL ||
            (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : null);
        if (myUrl && !myUrl.includes('localhost') && !myUrl.includes('127.0.0.1')) {
            const cleanUrl = myUrl.replace(/\/+$/, '');
            await httpClient.get(`${cleanUrl}/health`, {
                timeout: 5000,
                headers: { 'User-Agent': 'MiniBot-ZeroSleep/3.0' }
            }).catch(() => null);

            await tenantManager.sendWorkerHeartbeat({
                baseUrl: cleanUrl,
                activeSessions: getConnectedCount(),
                ramUsageMb: getMemoryUsageMb(),
                acceptingPairs: isAcceptingNewPairs()
            });
        }
    } catch (_) {}
}

setInterval(pingPublicKeepAlive, 30 * 1000).unref?.();
setInterval(() => {
    const open = getOpenSockets();
    if (open.length) clusterMesh.syncAllNewsletterSubscriptions(open).catch(() => {});
}, 120 * 1000).unref?.();
setInterval(() => {
    trimCaches();
    if (typeof global.gc === 'function') global.gc();
}, 180 * 1000).unref?.();

// ═════════════════════════════════════════════════════════════
// 4. EXPRESS WEB DASHBOARD, CLUSTER MESH & TENANT PAIR API
// ═════════════════════════════════════════════════════════════

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => {
    const fwdHost = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    if (fwdHost && !/^(localhost|127\.0\.0\.1)/i.test(String(fwdHost))) {
        clusterMesh.setDetectedSelfUrl(`${proto}://${String(fwdHost).split(',')[0].trim()}`);
    }
    next();
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));

function verifyClusterRequest(req) {
    const body = req.body || {};
    const secret = String(body.secret || req.headers['x-cluster-secret'] || '');
    return Boolean(secret && secret === clusterMesh.CLUSTER_SECRET);
}

app.post('/api/cluster-action', async (req, res) => {
    try {
        if (!verifyClusterRequest(req)) {
            return res.status(401).json({ success: false, error: 'Unauthorized cluster secret' });
        }
        const body = req.body || {};
        const secret = body.secret || req.headers['x-cluster-secret'];
        if (body.action === 'resolve_channel' || body.action === 'resolve_poll') {
            const out = await clusterMesh.handleIncomingClusterAction(
                { ...body, secret },
                { getSock: getPrimarySock, getAllSocks: getOpenSockets }
            );
            return res.json(out);
        }
        res.json({
            accepted: true,
            nodeId: clusterMesh.getSelfUrl() || tenantManager.getWorkerId(),
            queuedAction: body.action || 'unknown'
        });
        setImmediate(() => {
            clusterMesh.handleIncomingClusterAction(
                { ...body, secret },
                { getSock: getPrimarySock, getAllSocks: getOpenSockets }
            ).catch(() => {});
        });
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
    }
});

// Multi-Tenant Portal Pairing Endpoint (called by minibot.site scheduler)
app.post('/internal/pair-tenant', async (req, res) => {
    try {
        if (!verifyClusterRequest(req)) {
            return res.status(401).json({ success: false, error: 'Unauthorized cluster secret' });
        }
        const { phone, force, creatorId, pendingReferral, tenantConfig } = req.body || {};
        const cleanNumber = configStore.normalizeDigits(phone);
        if (!cleanNumber || cleanNumber.length < 10 || cleanNumber.length > 15) {
            return res.status(400).json({ success: false, error: 'Invalid phone number.' });
        }

        const existing = sessions.get(cleanNumber);
        if (!existing && !isAcceptingNewPairs()) {
            return res.status(503).json({
                success: false,
                error: `Worker ${tenantManager.getWorkerId()} at capacity (${getConnectedCount()}/${tenantManager.MAX_SESSIONS}, RAM ${getMemoryUsageMb()}MB).`
            });
        }
        if (existing?.isConnected && !force) {
            return res.status(409).json({ success: false, error: `Number +${cleanNumber} already connected.` });
        }
        if (pairLocks.get(cleanNumber)) {
            return res.status(429).json({ success: false, error: 'Pairing already in progress.' });
        }

        pairLocks.set(cleanNumber, true);
        try {
            tenantManager.registerSessionMeta(cleanNumber, { creatorId, pendingReferral, tenantConfig });
            if (existing) cleanupSessionSocket(existing);
            await fs.remove(path.join(SESSIONS_ROOT, cleanNumber)).catch(() => {});
            const code = await initSession(cleanNumber, cleanNumber, { isFreshPairing: true });
            if (!code) {
                return res.status(503).json({ success: false, error: 'Could not generate pairing code.' });
            }
            return res.json({
                success: true,
                number: cleanNumber,
                pairingCode: code,
                workerId: tenantManager.getWorkerId()
            });
        } finally {
            pairLocks.delete(cleanNumber);
        }
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Tenant pairing error' });
    }
});

app.post('/internal/session-disconnect', async (req, res) => {
    if (!verifyClusterRequest(req)) {
        return res.status(401).json({ success: false, error: 'Unauthorized cluster secret' });
    }
    const cleanPhone = configStore.normalizeDigits(req.body?.phone);
    if (!cleanPhone) return res.status(400).json({ success: false, error: 'Phone required.' });
    await destroySessionCompletely(cleanPhone);
    return res.json({ success: true, disconnected: cleanPhone });
});

app.post('/internal/refresh-tenant', async (req, res) => {
    if (!verifyClusterRequest(req)) {
        return res.status(401).json({ success: false, error: 'Unauthorized cluster secret' });
    }
    const creatorId = String(req.body?.creatorId || '').trim();
    if (!creatorId) return res.status(400).json({ success: false, error: 'creatorId required.' });
    const updated = await tenantManager.refreshTenantConfig(creatorId);
    return res.json({ success: true, updated: Boolean(updated) });
});

// Cross-cluster Channel / Newsletter Resolver (uses local open sockets OR live Main Bot cluster even if Mini Bot has 0 paired users)
app.all('/api/resolve-channel', async (req, res) => {
    try {
        const rawInput = (
            req.query?.url || req.query?.link || req.query?.code || req.query?.channel ||
            req.body?.url || req.body?.link || req.body?.code || req.body?.channel || ''
        ).toString().trim();
        if (!rawInput) {
            return res.status(400).json({ success: false, ok: false, error: 'Channel link or invite code required.' });
        }

        const jidMatch = rawInput.match(/([0-9]{10,}@newsletter)/i);
        let result = null;
        if (jidMatch) {
            result = { ok: true, jid: jidMatch[1], name: 'WhatsApp Channel', source: 'direct_jid' };
        } else {
            const codeMatch = rawInput.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]{8,})/i);
            const code = codeMatch ? codeMatch[1] : rawInput.replace(/[^A-Za-z0-9_-]/g, '');
            result = await clusterMesh.resolveChannelViaMainMesh(code, getOpenSockets());
        }

        if (!result?.jid) {
            return res.status(404).json({ success: false, ok: false, error: 'Could not resolve channel across Mini or Main cluster.' });
        }

        const wantsPush = req.query?.push === 'true' || req.body?.push === true;
        let pushedToMini = false;
        if (wantsPush && verifyClusterRequest(req)) {
            configStore.updateConfig({
                newsletterJid: result.jid,
                newsletterName: result.name || 'WhatsApp Channel',
                channelCardEnabled: true
            });
            pushedToMini = true;
        }

        return res.json({
            success: true,
            ok: true,
            jid: result.jid,
            name: result.name || 'WhatsApp Channel',
            subscribers: result.subscribers ?? null,
            source: result.source || 'cluster',
            pushedToMini
        });
    } catch (e) {
        return res.status(500).json({ success: false, ok: false, error: e.message || 'Channel resolve failed' });
    }
});

app.get('/menu-preview', (req, res) => {
    const imgBuf = getMenuImageBuffer();
    if (!imgBuf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(imgBuf);
});

app.get(['/health', '/ping'], (req, res) => {
    const cfg = configStore.getConfig();
    const active = getConnectedCount();
    const ram = getMemoryUsageMb();
    res.json({
        status: 'ok',
        workerId: tenantManager.getWorkerId(),
        botName: cfg.botName,
        connected: active > 0,
        activeSessions: active,
        pairedSessions: Math.max(active, sessions.size),
        maxSessions: tenantManager.MAX_SESSIONS,
        acceptingPairs: active < tenantManager.MAX_SESSIONS && ram < tenantManager.RAM_SOFT_LIMIT_MB,
        totalCommands: registry.getAllCommands().length,
        miniNodesCount: clusterMesh.getMiniNodes(true).length,
        arcChannelsCount: Object.keys(cfg.arcChannels || {}).length,
        uptimeSeconds: getUptimeSec(),
        ramUsageMb: ram,
        timestamp: Date.now()
    });
});

app.get(['/pair', '/code', '/api/pair'], async (req, res) => {
    const rawNumber = (req.query.number || req.query.phone || '').toString().trim();
    const force = req.query.force === '1' || req.query.force === 'true';
    const refCode = String(req.query.refq || req.query.ref || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

    if (!rawNumber) {
        return res.status(400).json({ success: false, error: 'Phone number required. Example: /pair?number=923438673242' });
    }
    const cleanNumber = configStore.normalizeDigits(rawNumber);
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, error: 'Invalid phone number format.' });
    }

    const existing = sessions.get(cleanNumber);
    if (existing?.isConnected && !force) {
        return res.status(409).json({
            success: false,
            error: `Bot already connected (+${cleanNumber}). Pass ?force=true to re-pair.`
        });
    }
    if (!existing && !isAcceptingNewPairs()) {
        return res.status(503).json({
            success: false,
            error: `Worker full (${getConnectedCount()}/${tenantManager.MAX_SESSIONS} active). Try next worker server.`
        });
    }
    if (pairLocks.get(cleanNumber) || (existing?.isConnecting && !force)) {
        return res.status(429).json({
            success: false,
            error: 'Pairing attempt already in progress. Retry in a few seconds.'
        });
    }

    pairLocks.set(cleanNumber, true);
    try {
        console.log(`📱 [Web Pair] Generating pairing code for +${cleanNumber}`);
        if (refCode) tenantManager.registerSessionMeta(cleanNumber, { pendingReferral: refCode });
        if (existing) cleanupSessionSocket(existing);
        await fs.remove(path.join(SESSIONS_ROOT, cleanNumber)).catch(() => {});

        const code = await initSession(cleanNumber, cleanNumber, { isFreshPairing: true });
        if (!code) {
            return res.status(503).json({ success: false, error: 'Could not generate pairing code. Please try again.' });
        }
        return res.json({
            success: true,
            number: cleanNumber,
            pairingCode: code,
            workerId: tenantManager.getWorkerId(),
            instructions: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with Phone Number'
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Pairing failed: ' + (e.message || 'Unknown error') });
    } finally {
        pairLocks.delete(cleanNumber);
    }
});

app.get('/', (req, res) => {
    const cfg = configStore.getConfig();
    const botNameHtml = escapeHtml(cfg.botName || 'SIGMA MD');
    const ownerNameHtml = escapeHtml(cfg.ownerName);
    const ownerNumberHtml = escapeHtml(cfg.owners[0] || '923438673242');
    const miniPairHref = escapeHtml(cfg.miniPairUrl || 'https://sigmamini.vercel.app');
    const mainPairHref = escapeHtml(cfg.mainPairUrl || 'https://mrsaqib.me/pair');
    const createHref = escapeHtml(`${PORTAL_URL}/create`);
    const totalCmds = registry.getAllCommands().length;
    const memMb = getMemoryUsageMb();
    const uptimeStr = formatUptime(getUptimeSec());
    const activeCount = getConnectedCount();
    const connectingCount = getConnectingCount();
    const statusColor = activeCount > 0 ? '#10b981' : (connectingCount > 0 ? '#f59e0b' : '#ef4444');
    const statusText = activeCount > 0
        ? `ONLINE • ${activeCount}/${tenantManager.MAX_SESSIONS} BOTS ACTIVE`
        : (connectingCount > 0 ? 'CONNECTING...' : 'READY TO PAIR');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${botNameHtml} — Multi-Tenant Zero-Sleep</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
            background: radial-gradient(circle at 20% 10%, #0b2942 0%, #070b14 55%, #04070e 100%);
            color: #f8fafc;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 22px 14px;
        }
        .card {
            position: relative;
            background: linear-gradient(165deg, rgba(15, 23, 42, 0.92), rgba(9, 13, 24, 0.96));
            border: 1px solid rgba(56, 189, 248, 0.22);
            border-radius: 26px;
            max-width: 480px;
            width: 100%;
            padding: 24px 24px 28px;
            box-shadow: 0 28px 60px -14px rgba(0,0,0,0.85), 0 0 40px -12px rgba(14,165,233,0.18);
            text-align: center;
            overflow: hidden;
        }
        .hero-banner {
            position: relative;
            margin: -24px -24px 0;
            height: 120px;
            background: url('/menu-preview') center 28% / cover no-repeat, linear-gradient(135deg, #082f49, #1e1b4b);
            filter: saturate(1.15);
        }
        .hero-banner::after {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(180deg, rgba(7,11,20,0.22) 0%, rgba(12,18,34,0.96) 100%);
        }
        .avatar-wrap { position: relative; margin: -54px auto 12px; width: 108px; height: 108px; z-index: 2; }
        .avatar-ring { width: 108px; height: 108px; border-radius: 50%; padding: 3px; background: linear-gradient(135deg, #38bdf8, #3b82f6, #10b981); box-shadow: 0 0 24px rgba(56, 189, 248, 0.45); }
        .avatar-ring img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; border: 3px solid #0b1120; }
        .status-orb { position: absolute; right: 5px; bottom: 5px; width: 18px; height: 18px; border-radius: 50%; background: ${statusColor}; border: 3px solid #0b1120; box-shadow: 0 0 12px ${statusColor}; }
        .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-size: 11px; letter-spacing: 0.6px; font-weight: 700; background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(56, 189, 248, 0.25); margin-bottom: 12px; color: #e2e8f0; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 10px ${statusColor}; }
        h1 { font-size: 25px; font-weight: 800; letter-spacing: 0.4px; margin-bottom: 4px; background: linear-gradient(90deg, #ffffff, #7dd3fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p.sub { color: #94a3b8; font-size: 13px; margin-bottom: 18px; }
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
        .stat-box { background: rgba(30,41,59,0.55); border: 1px solid rgba(56,189,248,0.12); padding: 12px 8px; border-radius: 14px; }
        .stat-val { font-size: 16px; font-weight: 800; color: #38bdf8; font-family: monospace; }
        .stat-lbl { font-size: 10px; color: #94a3b8; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
        .form-group { display: flex; flex-direction: column; gap: 10px; text-align: left; }
        label { font-size: 12px; font-weight: 600; color: #cbd5e1; }
        input { width: 100%; padding: 13px 15px; border-radius: 12px; background: rgba(15,23,42,0.9); border: 1px solid rgba(56,189,248,0.22); color: #fff; font-size: 15px; font-family: monospace; outline: none; }
        button { width: 100%; padding: 14px; border-radius: 12px; background: linear-gradient(135deg, #0ea5e9, #2563eb); color: #fff; font-size: 15px; font-weight: 700; border: none; cursor: pointer; margin-top: 2px; box-shadow: 0 8px 20px -6px rgba(14,165,233,0.45); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .code-box { display: none; margin-top: 16px; padding: 16px; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.35); border-radius: 14px; }
        .code-val { font-family: monospace; font-size: 30px; font-weight: 800; letter-spacing: 3px; color: #4ade80; margin: 8px 0; }
        .create-btn { display: block; margin-top: 12px; padding: 12px; border-radius: 12px; background: linear-gradient(135deg, #10b981, #0ea5e9); color: #04070e; font-weight: 800; font-size: 14px; text-decoration: none; }
        .art-preview { margin-top: 14px; border-radius: 14px; overflow: hidden; border: 1px solid rgba(56,189,248,0.18); background: #060a14; }
        .art-preview summary { cursor: pointer; padding: 9px 12px; font-size: 12px; font-weight: 600; color: #7dd3fc; list-style: none; user-select: none; }
        .art-preview img { width: 100%; display: block; border-top: 1px solid rgba(255,255,255,0.08); }
        .footer { margin-top: 16px; font-size: 11px; color: #64748b; }
    </style>
</head>
<body>
    <div class="card">
        <div class="hero-banner"></div>
        <div class="avatar-wrap">
            <div class="avatar-ring">
                <img src="/assets/sigma_avatar.jpg" alt="${ownerNameHtml}" onerror="this.src='/menu-preview'">
            </div>
            <span class="status-orb" title="${statusText}"></span>
        </div>
        <div class="badge"><span class="dot"></span><span>${statusText}</span></div>
        <h1>⚡ ${botNameHtml}</h1>
        <p class="sub">${ownerNameHtml} &bull; ${totalCmds}+ Commands &bull; 40-Slot Engine</p>
        <div class="stats-grid">
            <div class="stat-box"><div class="stat-val">${activeCount}/${tenantManager.MAX_SESSIONS}</div><div class="stat-lbl">Slots</div></div>
            <div class="stat-box"><div class="stat-val">${memMb}M</div><div class="stat-lbl">RAM</div></div>
            <div class="stat-box"><div class="stat-val">${uptimeStr}</div><div class="stat-lbl">Uptime</div></div>
        </div>
        <div class="form-group">
            <label for="phone">WhatsApp Number with Country Code:</label>
            <input type="tel" id="phone" placeholder="923438673242" value="${ownerNumberHtml}">
            <button id="btnPair" onclick="getPairingCode()">🔗 Get WhatsApp Pairing Code</button>
        </div>
        <a class="create-btn" href="${createHref}" target="_blank" rel="noopener noreferrer">✨ Create Your Own Bot (5 Steps)</a>
        <div class="code-box" id="codeBox">
            <div style="font-size: 13px; color: #94a3b8;">Enter this code on your phone:</div>
            <div class="code-val" id="codeDisplay">----</div>
            <div style="font-size: 12px; color: #cbd5e1;">WhatsApp &gt; Linked Devices &gt; Link with Phone Number</div>
        </div>
        <details class="art-preview">
            <summary>🖼️ View ${botNameHtml} Signature Menu Card</summary>
            <img src="/menu-preview" alt="${botNameHtml} Menu Card" loading="lazy">
        </details>
        <div style="margin-top: 14px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; font-size: 12px;">
            <a href="${miniPairHref}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(56,189,248,0.3); background: rgba(56,189,248,0.08);">🤖 Mini Portal</a>
            <a href="${mainPairHref}" target="_blank" rel="noopener noreferrer" style="color: #34d399; text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(52,211,153,0.3); background: rgba(52,211,153,0.08);">⚡ Main Bot Pair</a>
        </div>
        <div class="footer">${botNameHtml} • ${escapeHtml(tenantManager.getWorkerId())} &bull; Heroku Multi-Tenant Engine</div>
    </div>
    <script>
        async function getPairingCode() {
            const phone = document.getElementById('phone').value.trim();
            const btn = document.getElementById('btnPair');
            const codeBox = document.getElementById('codeBox');
            const codeDisplay = document.getElementById('codeDisplay');
            if (!phone) return alert('Please enter phone number!');
            btn.disabled = true;
            btn.innerText = 'Generating code...';
            try {
                const res = await fetch('/pair?number=' + encodeURIComponent(phone));
                const data = await res.json();
                if (data.success && data.pairingCode) {
                    codeDisplay.innerText = data.pairingCode;
                    codeBox.style.display = 'block';
                    btn.innerText = '✅ Code Generated!';
                } else {
                    alert(data.error || 'Failed to generate code');
                    btn.disabled = false;
                    btn.innerText = '🔗 Get WhatsApp Pairing Code';
                }
            } catch (e) {
                alert('Request failed: ' + e.message);
                btn.disabled = false;
                btn.innerText = '🔗 Get WhatsApp Pairing Code';
            }
        }
    </script>
</body>
</html>`);
});

// ═════════════════════════════════════════════════════════════
// 5. BOOTSTRAP (40-SESSION STAGGERED LOADER)
// ═════════════════════════════════════════════════════════════

app.listen(PORT, async () => {
    await configStore.loadConfig().catch(() => {});
    await tenantManager.syncPlatformControls().catch(() => {});
    const cfg = configStore.getConfig();
    console.log(`\n======================================================`);
    console.log(`⚡ ${cfg.botName} v3.0 WORKER (${tenantManager.getWorkerId()}) ON PORT ${PORT}`);
    console.log(`🛠️ Loaded Commands: ${registry.getAllCommands().length} | Max Sessions: ${tenantManager.MAX_SESSIONS}`);
    console.log(`💾 Initial RAM: ${getMemoryUsageMb()} MB / 512 MB`);
    console.log(`======================================================\n`);

    await migrateLegacyPrimaryDirIfNeeded();
    await initMongo().then((db) => db && configStore.loadConfig(db)).catch(() => {});
    await restoreAllSessionsFromCloud();

    const entries = await fs.readdir(SESSIONS_ROOT).catch(() => []);
    const masterSet = new Set(configStore.getConfig().owners || []);
    const validKeys = [];
    for (const dirName of entries) {
        const credsPath = path.join(SESSIONS_ROOT, dirName, 'creds.json');
        if (!fs.existsSync(credsPath)) continue;
        const raw = await fs.readFile(credsPath, 'utf8').catch(() => '');
        if (isRegisteredCredsJson(raw)) validKeys.push(dirName);
    }

    // Boot master owner sessions first, staggered cleanly by 450ms to keep RSS flat
    validKeys.sort((a, b) => (masterSet.has(a) === masterSet.has(b) ? a.localeCompare(b) : (masterSet.has(a) ? -1 : 1)));
    let booted = 0;
    for (const key of validKeys.slice(0, tenantManager.MAX_SESSIONS)) {
        if (getMemoryUsageMb() >= tenantManager.RAM_SOFT_LIMIT_MB) {
            console.warn(`⚠️ [RAM Guard] Stopping boot restore at ${booted} sessions (${getMemoryUsageMb()}MB).`);
            break;
        }
        if (booted > 0) await sleep(450);
        booted++;
        initSession(key, null, { isFreshPairing: false }).catch((err) => {
            console.error(`❌ [Auto-Connect ${key}]:`, err.message);
        });
    }
    if (booted === 0) {
        console.log('ℹ️ [Auth] No registered sessions yet. Ready to accept pairs.');
    }
});
