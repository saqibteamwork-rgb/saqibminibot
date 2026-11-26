'use strict';

/**
 * SIGMA MD :: Animated Lottie Stickers, Personal Saved Stickers (.sts/.rs/.was),
 * Pure-Node WebP EXIF Watermark (.take/.sticker/.toimg) & AI Suite (.ai/.flux)
 * Ultra-lightweight with zero heavy native npm dependencies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { generateWAMessageFromContent, jidNormalizedUser } = require('@whiskeysockets/baileys');
const configStore = require('../configStore');
const {
    httpClient,
    extractMedia,
    unwrapMessage,
    getContextInfo,
    getTextFromContent,
    sleep,
    withTimeout
} = require('../mediaHelper');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SAQIB_LOTTIE_DB = path.join(DATA_DIR, 'saqib_lottie.json');
const SAVED_STICKER_DB = path.join(DATA_DIR, 'saved_stickers.json');

// Default Animated Lottie / .was payload synced from SIGMA MD / copycat-md
const DEFAULT_LOTTIE_DATA = {
    url: 'https://mmg.whatsapp.net/v/t62.15575-24/566253521_26758064397111035_6867016343469098353_n.enc?ccb=11-4&oh=01_Q5Aa4wHxn9t9dW5jD7qH2w-y46oJYZ9a4uM477G0-1MXYF97Xg&oe=6A16958D&_nc_sid=5e03e0&mms3=true',
    fileSha256: '48tU43g+g7tY1O8h7u6X+s4h3J/rO3j4S2cM1nS492k=',
    fileEncSha256: '57/rP0P+06c6t1y9N2y5O+9M2H9Y4U6v9B5/vL3xY4U=',
    mediaKey: '9O7nF7+zK5C1X9W4/v7U7w2v4S8L5M1N4P6Y2B7Z5Y4=',
    mimetype: 'application/was',
    directPath: '/v/t62.15575-24/566253521_26758064397111035_6867016343469098353_n.enc?ccb=11-4&oh=01_Q5Aa4wHxn9t9dW5jD7qH2w-y46oJYZ9a4uM477G0-1MXYF97Xg&oe=6A16958D&_nc_sid=5e03e0',
    fileLength: 203306,
    mediaKeyTimestamp: 1795153103,
    isAnimated: true,
    stickerSentTs: '1795153161253',
    isAvatar: false,
    isAiSticker: false,
    isLottie: true,
    label: 'MR SAQIB Lottie Pack'
};

function readJsonSafe(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (_) {}
    return fallback;
}

function writeJsonSafe(filePath, data) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (_) {
        return false;
    }
}

function getStickerDb(filePath) {
    const db = readJsonSafe(filePath, { list: [], defaultIndex: 0 });
    if (!Array.isArray(db.list) || db.list.length === 0) {
        return { list: [DEFAULT_LOTTIE_DATA], defaultIndex: 0 };
    }
    return db;
}

function toB64Buffer(val) {
    if (!val) return Buffer.alloc(0);
    if (Buffer.isBuffer(val)) return val;
    if (typeof val === 'string') return Buffer.from(val, 'base64');
    if (Array.isArray(val) || val instanceof Uint8Array) return Buffer.from(val);
    if (val?.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data);
    return Buffer.alloc(0);
}

function normalizeWaStickerData(s = {}) {
    return {
        url: s.url || DEFAULT_LOTTIE_DATA.url,
        fileSha256: typeof s.fileSha256 === 'string' ? s.fileSha256 : toB64Buffer(s.fileSha256).toString('base64'),
        fileEncSha256: typeof s.fileEncSha256 === 'string' ? s.fileEncSha256 : toB64Buffer(s.fileEncSha256).toString('base64'),
        mediaKey: typeof s.mediaKey === 'string' ? s.mediaKey : toB64Buffer(s.mediaKey).toString('base64'),
        mimetype: s.mimetype || 'image/webp',
        directPath: s.directPath || '',
        fileLength: Number(s.fileLength) || 0,
        mediaKeyTimestamp: Number(s.mediaKeyTimestamp) || Math.floor(Date.now() / 1000),
        isAnimated: Boolean(s.isAnimated),
        stickerSentTs: String(s.stickerSentTs || Date.now()),
        isAvatar: Boolean(s.isAvatar),
        isAiSticker: Boolean(s.isAiSticker),
        isLottie: Boolean(s.isLottie || s.mimetype === 'application/was'),
        accessibilityLabel: s.accessibilityLabel || s.label || 'SIGMA MD Sticker'
    };
}

function buildStickerMessageObject(s, sock) {
    const botJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : '';
    const norm = normalizeWaStickerData(s);
    const ts = Number(norm.mediaKeyTimestamp) || Math.floor(Date.now() / 1000);
    return {
        url: norm.url,
        fileSha256: toB64Buffer(norm.fileSha256),
        fileEncSha256: toB64Buffer(norm.fileEncSha256),
        mediaKey: toB64Buffer(norm.mediaKey),
        mimetype: norm.mimetype,
        directPath: norm.directPath,
        fileLength: norm.fileLength,
        mediaKeyTimestamp: ts,
        isAnimated: norm.isAnimated,
        contextInfo: {
            ...(botJid ? { pairedMediaRecipients: [{ jid: botJid }] } : {}),
            forwardingScore: 1,
            isForwarded: false
        },
        stickerSentTs: String(norm.stickerSentTs || (ts * 1000)),
        isAvatar: norm.isAvatar,
        isAiSticker: norm.isAiSticker,
        isLottie: norm.isLottie,
        accessibilityLabel: norm.accessibilityLabel
    };
}

async function sendStickerAnnotationReact(sock, from, targetMsg, stickerObj) {
    const botJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : `${sock?.user?.id || ''}`;
    const unwrapped = unwrapMessage(targetMsg?.message);
    const mCtx = getContextInfo(unwrapped);
    if (!mCtx?.stanzaId) throw new Error('Quoted message key missing');

    const isGroup = from.endsWith('@g.us');
    const participant = mCtx.participant || (isGroup ? botJid : from);
    const parentKey = {
        remoteJid: from,
        fromMe: participant && botJid ? participant.split('@')[0].split(':')[0] === botJid.split('@')[0].split(':')[0] : false,
        id: mCtx.stanzaId,
        ...(isGroup && participant ? { participant } : {})
    };

    const stickerPayload = buildStickerMessageObject(stickerObj, sock);
    const payload = {
        messageContextInfo: {
            messageAssociation: {
                associationType: 11,
                parentMessageKey: parentKey
            }
        },
        associatedChildMessage: {
            message: {
                stickerMessage: stickerPayload
            }
        }
    };

    const waMsg = generateWAMessageFromContent(from, payload, { userJid: botJid || from });
    await withTimeout(sock.relayMessage(from, waMsg.message, { messageId: waMsg.key.id }), 8000, 'Sticker react relay');
    return waMsg;
}

// ── Per-User Saved Stickers Store ───────────────────────────────────────────
function getUserStickerBucket(userKey) {
    const db = readJsonSafe(SAVED_STICKER_DB, { users: {} });
    if (!db.users || typeof db.users !== 'object') db.users = {};
    return { db, bucket: Array.isArray(db.users[userKey]) ? db.users[userKey] : [] };
}

function getCallerStickerKey(ctx) {
    return ctx.senderDigits || ctx.from || 'default';
}

// ── Pure-Node WebP RIFF/VP8X EXIF Injector (Zero Native Deps) ──────────────
function buildStickerExifBuffer(packName = 'SIGMA MD', authorName = 'MR SAQIB') {
    const jsonObj = {
        'sticker-pack-id': crypto.randomBytes(8).toString('hex'),
        'sticker-pack-name': String(packName || 'SIGMA MD').slice(0, 64),
        'sticker-pack-publisher': String(authorName || 'MR SAQIB').slice(0, 64),
        emojis: ['⚡']
    };
    const jsonBuf = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    const tiffHeader = Buffer.from([
        0x49, 0x49, 0x2a, 0x00,
        0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x41, 0x57,
        0x07, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x16, 0x00, 0x00, 0x00
    ]);
    tiffHeader.writeUInt32LE(jsonBuf.length, 14);
    return Buffer.concat([tiffHeader, jsonBuf]);
}

function parseWebpDimensions(chunks) {
    for (const c of chunks) {
        if (c.tag === 'VP8X' && c.data.length >= 10) {
            const w = (c.data[4] | (c.data[5] << 8) | (c.data[6] << 16)) + 1;
            const h = (c.data[7] | (c.data[8] << 8) | (c.data[9] << 16)) + 1;
            return { w, h };
        }
        if (c.tag === 'VP8 ' && c.data.length >= 10 && c.data[3] === 0x9d && c.data[4] === 0x01 && c.data[5] === 0x2a) {
            const w = c.data.readUInt16LE(6) & 0x3fff;
            const h = c.data.readUInt16LE(8) & 0x3fff;
            if (w && h) return { w, h };
        }
        if (c.tag === 'VP8L' && c.data.length >= 5 && c.data[0] === 0x2f) {
            const bits = c.data.readUInt32LE(1);
            const w = (bits & 0x3fff) + 1;
            const h = ((bits >> 14) & 0x3fff) + 1;
            return { w, h };
        }
    }
    return { w: 512, h: 512 };
}

function injectExifIntoWebp(webpBuf, exifPayload) {
    if (!Buffer.isBuffer(webpBuf) || webpBuf.length < 16 || webpBuf.toString('ascii', 0, 4) !== 'RIFF' || webpBuf.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('Invalid WebP sticker buffer.');
    }
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= webpBuf.length) {
        const tag = webpBuf.toString('ascii', offset, offset + 4);
        const len = webpBuf.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = Math.min(webpBuf.length, start + len);
        chunks.push({ tag, data: webpBuf.subarray(start, end) });
        offset = start + len + (len % 2);
    }

    const { w, h } = parseWebpDimensions(chunks);
    const hasAnim = chunks.some((c) => c.tag === 'ANIM' || c.tag === 'ANMF');
    let vp8x = chunks.find((c) => c.tag === 'VP8X');
    const filtered = chunks.filter((c) => c.tag !== 'EXIF' && c.tag !== 'VP8X');

    const vp8xData = vp8x ? Buffer.from(vp8x.data) : Buffer.alloc(10, 0);
    vp8xData[0] = (vp8xData[0] || 0) | 0x08 | (hasAnim ? 0x02 : 0x00) | 0x10;
    const wm1 = Math.max(0, w - 1);
    const hm1 = Math.max(0, h - 1);
    vp8xData[4] = wm1 & 0xff;
    vp8xData[5] = (wm1 >> 8) & 0xff;
    vp8xData[6] = (wm1 >> 16) & 0xff;
    vp8xData[7] = hm1 & 0xff;
    vp8xData[8] = (hm1 >> 8) & 0xff;
    vp8xData[9] = (hm1 >> 16) & 0xff;

    const finalChunks = [
        { tag: 'VP8X', data: vp8xData },
        ...filtered,
        { tag: 'EXIF', data: exifPayload }
    ];

    const parts = [Buffer.from('WEBP')];
    for (const c of finalChunks) {
        const header = Buffer.alloc(8);
        header.write(c.tag, 0, 4, 'ascii');
        header.writeUInt32LE(c.data.length, 4);
        parts.push(header, c.data);
        if (c.data.length % 2 === 1) parts.push(Buffer.from([0]));
    }
    const body = Buffer.concat(parts);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 4, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
}

let cachedSystemFfmpeg = null;
function hasSystemFfmpeg() {
    if (cachedSystemFfmpeg !== null) return cachedSystemFfmpeg;
    try {
        const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2500 });
        cachedSystemFfmpeg = res.status === 0;
    } catch (_) {
        cachedSystemFfmpeg = false;
    }
    return cachedSystemFfmpeg;
}

function runFfmpegSync(args) {
    const res = spawnSync('ffmpeg', args, { stdio: 'ignore', timeout: 20000 });
    return res.status === 0;
}

// ── AI Query Hub (LuxuryStudioWeb Multi-Model Failover) ──────────────────────
const AI_MODELS = [
    { name: 'Mistral Small 4', url: 'https://luxurystudioweb.com/ai/api/mistralai/mistral-small-2603' },
    { name: 'Mistral Large 3', url: 'https://luxurystudioweb.com/ai/api/mistralai/mistral-large-2512' },
    { name: 'Codestral 2508', url: 'https://luxurystudioweb.com/ai/api/mistralai/codestral-2508' },
    { name: 'Mistral Medium 3.5', url: 'https://luxurystudioweb.com/ai/api/mistralai/mistral-medium-3.5' },
    { name: 'SenseNova 6.8 Flash', url: 'https://luxurystudioweb.com/ai/api/sensenova/sensenova-6.8-flash-lite' }
];

async function queryAiWithFailover(question, contextText = '') {
    const prompt = contextText ? `Context:\n"${contextText}"\n\nQuestion:\n${question}` : question;
    let lastErr = null;
    for (const model of AI_MODELS) {
        try {
            const res = await httpClient.get(`${model.url}?text=${encodeURIComponent(prompt)}`, {
                timeout: 22000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const ans = res.data?.response || res.data?.reply || (typeof res.data === 'string' ? res.data : '');
            if (ans && String(ans).trim().length > 0) {
                return { model: model.name, answer: String(ans).trim() };
            }
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('AI servers busy hain, thori dair baad try karein.');
}

const commands = [
    // ── Animated Lottie Stickers (.saqib / .saqibsend / .saqreact) ───────────
    {
        name: 'saqib',
        aliases: ['saq', 'saqsticker', 'saqibsticker', 'lottie2', 'was2', 'premiumsticker', 'lottiesticker'],
        category: 'sticker',
        desc: 'SIGMA Animated Lottie (.was) sticker send ya react karein',
        handler: async (ctx) => {
            const db = getStickerDb(SAQIB_LOTTIE_DB);
            const arg0 = (ctx.args[0] || '').toLowerCase();

            if (arg0 === 'info') {
                const active = db.list[db.defaultIndex] || DEFAULT_LOTTIE_DATA;
                return ctx.reply(
                    `🎭 *SIGMA LOTTIE (.WAS) ENGINE*\n` +
                    `• *Active:* ${active.label || 'MR SAQIB Lottie'}\n` +
                    `• *Mimetype:* \`${active.mimetype}\`\n` +
                    `• *Saved Count:* ${db.list.length}\n` +
                    `• *React Reply:* Kisi message par reply karke *${ctx.prefix}saqreact* likhein\n` +
                    `• *Save New:* Sticker par reply karke *${ctx.prefix}saqib save <name>* likhein`
                );
            }

            if (arg0 === 'save' || arg0 === 'add') {
                const st = ctx.quotedMsg?.stickerMessage;
                if (!st?.url || !st?.mediaKey) {
                    return ctx.reply(`❌ Kisi animated/Lottie sticker par reply karke *${ctx.prefix}saqib save [name]* likhein!`);
                }
                const saved = normalizeWaStickerData({ ...st, label: ctx.args.slice(1).join(' ') || `Lottie #${db.list.length + 1}` });
                db.list.push(saved);
                db.defaultIndex = db.list.length - 1;
                writeJsonSafe(SAQIB_LOTTIE_DB, db);
                return ctx.reply(`✅ *Lottie Sticker Saved!* (#${db.list.length}: ${saved.accessibilityLabel})`);
            }

            const active = db.list[db.defaultIndex] || DEFAULT_LOTTIE_DATA;
            const digits = arg0.replace(/[^0-9]/g, '');
            if (digits.length >= 7 && !ctx.quotedMsg) {
                const targetJid = `${digits}@s.whatsapp.net`;
                const payload = buildStickerMessageObject(active, ctx.sock);
                await withTimeout(ctx.sock.relayMessage(targetJid, { stickerMessage: payload }, {}), 8000, 'Saqib forward');
                return ctx.reply(`✅ *Lottie Sticker +${digits} par bhej diya gaya!*`);
            }

            ctx.react('🎭');
            if (ctx.quotedMsg) {
                try {
                    await sendStickerAnnotationReact(ctx.sock, ctx.from, ctx.msg, active);
                    ctx.react('✅');
                    return;
                } catch (_) {}
            }
            const payload = buildStickerMessageObject(active, ctx.sock);
            await withTimeout(ctx.sock.relayMessage(ctx.from, { stickerMessage: payload }, {}), 8000, 'Saqib sticker send');
            ctx.react('✅');
        }
    },
    {
        name: 'saqibsend',
        aliases: ['saqsend', 'sendlottie', 'saqibdirect', 'saqdirect'],
        category: 'sticker',
        desc: 'Standalone SIGMA Animated Lottie (.was) sticker send karein',
        handler: async (ctx) => {
            const db = getStickerDb(SAQIB_LOTTIE_DB);
            const active = db.list[db.defaultIndex] || DEFAULT_LOTTIE_DATA;
            ctx.react('🎭');
            const payload = buildStickerMessageObject(active, ctx.sock);
            await withTimeout(ctx.sock.relayMessage(ctx.from, { stickerMessage: payload }, {}), 8000, 'Saqib direct send');
            ctx.react('✅');
        }
    },
    {
        name: 'saqreact',
        aliases: ['saqibreact', 'reactlottie'],
        category: 'sticker',
        desc: 'Replied message par Animated Lottie sticker reaction lagayein',
        handler: async (ctx) => {
            if (!ctx.quotedMsg) {
                return ctx.reply(`❌ Kisi message par reply karke *${ctx.prefix}saqreact* likhein!`);
            }
            const db = getStickerDb(SAQIB_LOTTIE_DB);
            const active = db.list[db.defaultIndex] || DEFAULT_LOTTIE_DATA;
            ctx.react('🎭');
            await sendStickerAnnotationReact(ctx.sock, ctx.from, ctx.msg, active);
            ctx.react('✅');
        }
    },

    // ── Personal Saved Stickers & Mixup Reactions (.sts / .stssend / .rs / .was) ─
    {
        name: 'sts',
        aliases: ['savesticker', 'setsticker', 'addsticker'],
        category: 'sticker',
        desc: 'Sticker save karein (.sts save) jo .rs / .stssend mein use ho',
        handler: async (ctx) => {
            const userKey = getCallerStickerKey(ctx);
            const { db, bucket } = getUserStickerBucket(userKey);
            const sub = (ctx.args[0] || '').toLowerCase();

            if (sub === 'del' || sub === 'clear') {
                db.users[userKey] = [];
                writeJsonSafe(SAVED_STICKER_DB, db);
                return ctx.reply('🗑️ Aapke saved stickers clear ho gaye.');
            }
            if (sub === 'list') {
                return ctx.reply(`🎨 *Aapke Saved Stickers:* ${bucket.length}\nUse *${ctx.prefix}stssend* to send or *${ctx.prefix}rs* on any message!`);
            }

            const qUnwrapped = unwrapMessage(ctx.quotedMsg);
            const st = qUnwrapped?.stickerMessage;
            if (st?.url && st?.mediaKey) {
                const entry = normalizeWaStickerData({ ...st, label: ctx.args.join(' ') || `Sticker #${bucket.length + 1}` });
                db.users[userKey] = [...bucket.slice(-9), entry];
                writeJsonSafe(SAVED_STICKER_DB, db);
                return ctx.reply(`✅ *Sticker Saved (#${db.users[userKey].length})!*\nAb kisi bhi message par reply karke *${ctx.prefix}rs* likhein!`);
            }

            if (bucket.length > 0) {
                return ctx.reply(
                    `🎨 *Saved Stickers (${bucket.length}):*\n` +
                    `• *${ctx.prefix}stssend* — Saved sticker send karein\n` +
                    `• *${ctx.prefix}rs* — Kisi message par sticker react lagayein\n` +
                    `• *${ctx.prefix}sts* (reply to sticker) — Naya sticker save karein`
                );
            }
            return ctx.reply(`📌 Kisi *Sticker* par reply karke *${ctx.prefix}sts* likhein taake wo aapka personal react sticker ban jaye!`);
        }
    },
    {
        name: 'stssend',
        aliases: ['getsticker', 'sendsts'],
        category: 'sticker',
        desc: 'Apna saved personal sticker bhejein',
        handler: async (ctx) => {
            const { bucket } = getUserStickerBucket(getCallerStickerKey(ctx));
            const chosen = bucket[bucket.length - 1];
            if (!chosen) {
                return ctx.reply(`❌ Pehle kisi sticker par reply karke *${ctx.prefix}sts* se save karein!`);
            }
            const payload = buildStickerMessageObject(chosen, ctx.sock);
            await withTimeout(ctx.sock.relayMessage(ctx.from, { stickerMessage: payload }, {}), 8000, 'Saved sticker send');
        }
    },
    {
        name: 'rs',
        aliases: ['rs5', 'rs10', 'sreact'],
        category: 'sticker',
        desc: 'Replied message par apna saved sticker reaction lagayein (.rs / .rs5)',
        handler: async (ctx) => {
            if (!ctx.quotedMsg) {
                return ctx.reply(`❌ Kisi message par reply karke *${ctx.prefix}rs* likhein!`);
            }
            const { bucket } = getUserStickerBucket(getCallerStickerKey(ctx));
            const chosen = bucket[bucket.length - 1] || DEFAULT_LOTTIE_DATA;
            let repeatCount = 1;
            if (ctx.commandName === 'rs5') repeatCount = 5;
            else if (ctx.commandName === 'rs10') repeatCount = 5;
            else if (/^\d+$/.test(ctx.args[0] || '')) {
                repeatCount = Math.max(1, Math.min(5, parseInt(ctx.args[0], 10)));
            }

            ctx.react('⚡');
            for (let i = 0; i < repeatCount; i++) {
                await sendStickerAnnotationReact(ctx.sock, ctx.from, ctx.msg, chosen);
                if (i < repeatCount - 1) await sleep(650);
            }
            ctx.react('✅');
        }
    },
    {
        name: 'was',
        aliases: ['wassticker', 'lottiewas'],
        category: 'sticker',
        desc: 'Animated .was Lottie sticker bhejein ya react karein',
        handler: async (ctx) => {
            const db = getStickerDb(SAQIB_LOTTIE_DB);
            const active = db.list[db.defaultIndex] || DEFAULT_LOTTIE_DATA;
            if (ctx.quotedMsg && (ctx.args[0] || '').toLowerCase() === 'react') {
                await sendStickerAnnotationReact(ctx.sock, ctx.from, ctx.msg, active);
                return ctx.react('✅');
            }
            const payload = buildStickerMessageObject(active, ctx.sock);
            await withTimeout(ctx.sock.relayMessage(ctx.from, { stickerMessage: payload }, {}), 8000, 'WAS sticker send');
            ctx.react('✅');
        }
    },

    // ── Pure-Node EXIF Watermark / Sticker Maker / ToImg ─────────────────────
    {
        name: 'take',
        aliases: ['wm', 'stealstk', 'swm', 'setwm', 'stkname'],
        category: 'sticker',
        desc: 'Sticker par apna Pack & Author watermark lagayein (.take Pack | Author)',
        handler: async (ctx) => {
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!media || media.mediaType !== 'sticker') {
                return ctx.reply(`Usage: Kisi *Sticker* par reply karke *${ctx.prefix}take PackName | Author* likhein!`);
            }
            const cfg = configStore.getConfig();
            const rawParts = String(ctx.fullArgs || '').split('|').map(s => s.trim());
            const packName = rawParts[0] || cfg.botName || 'SIGMA MD';
            const authorName = rawParts[1] || cfg.ownerName || 'MR SAQIB';
            try {
                ctx.react('⏳');
                const exif = buildStickerExifBuffer(packName, authorName);
                const tagged = injectExifIntoWebp(media.buffer, exif);
                await ctx.sock.sendMessage(ctx.from, { sticker: tagged }, ctx.quoteOpt);
                ctx.react('✅');
            } catch (e) {
                await ctx.reply(`❌ Watermark apply nahi ho saka: ${e.message}`);
            }
        }
    },
    {
        name: 'sticker',
        aliases: ['s', 'stk', 'stiker', 'stkr', 'stik', 'makesticker', 'stickergif'],
        category: 'sticker',
        desc: 'Photo, GIF ya WebP ko WhatsApp Sticker banayein',
        handler: async (ctx) => {
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!media || !['image', 'video', 'sticker'].includes(media.mediaType)) {
                return ctx.reply(`Usage: Kisi *Photo, Video ya Sticker* par reply karke *${ctx.prefix}sticker* likhein!`);
            }
            const cfg = configStore.getConfig();
            const exif = buildStickerExifBuffer(cfg.botName || 'SIGMA MD', cfg.ownerName || 'MR SAQIB');

            if (media.mediaType === 'sticker' || String(media.mimetype || '').includes('webp')) {
                const tagged = injectExifIntoWebp(media.buffer, exif);
                await ctx.sock.sendMessage(ctx.from, { sticker: tagged }, ctx.quoteOpt);
                return ctx.react('✅');
            }

            if (!hasSystemFfmpeg()) {
                return ctx.reply(
                    `⚠️ Is ultra-lightweight Heroku container mein *ffmpeg* binary install nahi hai (taake RAM 160MB ke andar rahe).\n\n` +
                    `💡 *Working Sticker Commands:*\n` +
                    `• *${ctx.prefix}take* (sticker watermark)\n` +
                    `• *${ctx.prefix}ssound* (sound sticker)\n` +
                    `• *${ctx.prefix}saqib* / *${ctx.prefix}was* / *${ctx.prefix}rs*`
                );
            }

            ctx.react('⏳');
            const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            const inFile = path.join(os.tmpdir(), `in_${stamp}.${media.mediaType === 'video' ? 'mp4' : 'img'}`);
            const outFile = path.join(os.tmpdir(), `out_${stamp}.webp`);
            try {
                fs.writeFileSync(inFile, media.buffer);
                const ffArgs = media.mediaType === 'video'
                    ? ['-y', '-i', inFile, '-t', '6', '-vf', 'fps=12,scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-loop', '0', '-an', '-vsync', '0', outFile]
                    : ['-y', '-i', inFile, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '75', outFile];
                if (!runFfmpegSync(ffArgs) || !fs.existsSync(outFile)) {
                    throw new Error('FFmpeg conversion failed');
                }
                const outWebp = injectExifIntoWebp(fs.readFileSync(outFile), exif);
                await ctx.sock.sendMessage(ctx.from, { sticker: outWebp }, ctx.quoteOpt);
                ctx.react('✅');
            } catch (e) {
                await ctx.reply(`❌ Sticker conversion failed: ${e.message}`);
            } finally {
                try { if (fs.existsSync(inFile)) fs.unlinkSync(inFile); } catch (_) {}
                try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
            }
        }
    },
    {
        name: 'toimg',
        aliases: ['photo', 's2img', 'stoimg', 'stickertoimage', 'toimage'],
        category: 'sticker',
        desc: 'Static Sticker ko wapas Image mein convert karein',
        handler: async (ctx) => {
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!media || media.mediaType !== 'sticker') {
                return ctx.reply(`Usage: Kisi *Sticker* par reply karke *${ctx.prefix}toimg* likhein!`);
            }
            if (!hasSystemFfmpeg()) {
                await ctx.sock.sendMessage(ctx.from, {
                    document: media.buffer,
                    mimetype: 'image/webp',
                    fileName: 'sticker.webp',
                    caption: '🖼️ *Sticker WebP File* (ffmpeg server par nahi hai, is liye direct WebP bheja gaya).'
                }, ctx.quoteOpt);
                return;
            }
            ctx.react('⏳');
            const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            const inFile = path.join(os.tmpdir(), `st_${stamp}.webp`);
            const outFile = path.join(os.tmpdir(), `im_${stamp}.png`);
            try {
                fs.writeFileSync(inFile, media.buffer);
                if (!runFfmpegSync(['-y', '-i', inFile, '-frames:v', '1', outFile]) || !fs.existsSync(outFile)) {
                    throw new Error('Conversion failed');
                }
                await ctx.sock.sendMessage(ctx.from, {
                    image: fs.readFileSync(outFile),
                    caption: '🖼️ *Sticker Converted to Image!*'
                }, ctx.quoteOpt);
                ctx.react('✅');
            } catch (e) {
                await ctx.reply(`❌ Image conversion error: ${e.message}`);
            } finally {
                try { if (fs.existsSync(inFile)) fs.unlinkSync(inFile); } catch (_) {}
                try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
            }
        }
    },

    // ── AI Assistant & Image Generation (.ai / .flux) ────────────────────────
    {
        name: 'ai',
        aliases: ['ask', 'gpt', 'chatgpt'],
        category: 'tools',
        desc: 'AI Assistant se sawal puchein (.ai Pakistan ka capital kya hai?)',
        handler: async (ctx) => {
            const quotedText = ctx.quotedMsg ? getTextFromContent(unwrapMessage(ctx.quotedMsg)) : '';
            const question = ctx.fullArgs || quotedText;
            if (!question) {
                return ctx.reply(`Usage: *${ctx.prefix}ai <sawal>*\nExample: *${ctx.prefix}ai Write a short Dua for success*`);
            }
            ctx.react('🤖');
            try {
                const { model, answer } = await queryAiWithFailover(question, ctx.fullArgs ? quotedText : '');
                await ctx.reply(
                    `🤖 *SIGMA AI* _(${model})_\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${answer.slice(0, 3500)}`
                );
                ctx.react('✅');
            } catch (e) {
                await ctx.reply(`❌ *AI Error:* ${e.message}`);
            }
        }
    },
    {
        name: 'flux',
        aliases: ['imagine', 'photoai', 'pixart', 'aiimage'],
        category: 'tools',
        desc: 'Text prompt se HD AI Image generate karein (.flux cyberpunk lion)',
        handler: async (ctx) => {
            if (!ctx.fullArgs) {
                return ctx.reply(`Usage: *${ctx.prefix}flux <prompt>*\nExample: *${ctx.prefix}flux luxury black sports car in rain*`);
            }
            ctx.react('🎨');
            const model = ctx.commandName.includes('pixart') ? 'pixart' : 'flux';
            const seed = Math.floor(Math.random() * 999999);
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(ctx.fullArgs)}?width=1024&height=1024&model=${model}&nologo=true&enhance=true&seed=${seed}`;
            try {
                const res = await httpClient.get(url, { responseType: 'arraybuffer', timeout: 55000 });
                const buf = Buffer.from(res.data);
                if (buf.length < 1500) throw new Error('Image generate nahi ho saki.');
                await ctx.sock.sendMessage(ctx.from, {
                    image: buf,
                    caption: `✨ *AI IMAGE (${model.toUpperCase()})*\n📝 *Prompt:* ${ctx.fullArgs}`
                }, ctx.quoteOpt);
                ctx.react('✅');
            } catch (e) {
                await ctx.reply(`❌ *AI Image Error:* ${e.message || 'Server busy'}`);
            }
        }
    }
];

module.exports = commands;
module.exports._internals = {
    buildStickerExifBuffer,
    injectExifIntoWebp,
    buildStickerMessageObject,
    DEFAULT_LOTTIE_DATA
};
