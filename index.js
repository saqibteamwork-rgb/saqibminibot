'use strict';

/**
 * ============================================================================
 * SIGMA MD v2.0 :: ULTRA-LIGHTWEIGHT 24/7 ZERO-SLEEP WHATSAPP BOT
 * ============================================================================
 * - Baileys v7 (@whiskeysockets/baileys) with @lid <-> @s.whatsapp.net support
 * - 145+ Commands across Menu, Owner, Group, Channel, Downloader & Tools
 * - Lean MongoDB Atlas cloud backup + 401 anti-logout shield
 * - Safe /pair endpoint + 25s Heroku keepalive + crash guards
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
const SESSION_DIR = path.join(__dirname, 'session');
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const BOOT_TIME = Date.now();

fs.ensureDirSync(SESSION_DIR);

// Global process crash shields
process.on('uncaughtException', (err) => {
    console.error('🛡️ [UncaughtException Guard]:', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🛡️ [UnhandledRejection Guard]:', reason?.stack || reason?.message || reason);
});

let sock = null;
let isConnected = false;
let isConnecting = false;
let connectStartedAt = 0;
let reconnectTimer = null;
let consecutive401Count = 0;
let currentPairingCode = null;
let cachedBaileysVersion = Array.isArray(DEFAULT_CONNECTION_CONFIG?.version) ? DEFAULT_CONNECTION_CONFIG.version : [2, 3000, 1043857760];
let versionRefreshStarted = false;

let cachedBotPn = null;
let cachedBotLid = null;
let cachedBotDigits = '';
let cachedPrefixKey = '';
let cachedPrefixRegex = null;

let mongoClient = null;
let mongoDb = null;
let mongoConnecting = false;
let backupDebounceTimer = null;
let backupInFlight = false;
let lastBackupHash = '';

// Bounded Caches (keeps Heroku RAM safely below 120MB)
const messageStore = new Map();
const processedMsgIds = new Set();
const antideleteCache = new Map();
const groupMetaCache = new Map();
const inFlightGroupMeta = new Map();
const GROUP_META_TTL_MS = 5 * 60 * 1000;

function capSet(set, key, max = 1500) {
    set.add(key);
    if (set.size > max) {
        const first = set.values().next().value;
        set.delete(first);
    }
}

function capMap(map, key, val, max = 2000) {
    map.set(key, val);
    if (map.size > max) {
        const first = map.keys().next().value;
        map.delete(first);
    }
}

function cacheMessage(msg) {
    if (!msg?.key?.id || !msg?.message) return;
    const id = msg.key.id;
    capMap(messageStore, id, msg.message, 2000);
    if (msg.key.remoteJid) {
        capMap(messageStore, `${msg.key.remoteJid}:${id}`, msg.message, 2000);
    }
}

async function getCachedGroupMeta(jid) {
    if (!jid || !sock) return null;
    const hit = groupMetaCache.get(jid);
    if (hit && Date.now() - hit.ts < GROUP_META_TTL_MS) return hit.meta;
    if (inFlightGroupMeta.has(jid)) return inFlightGroupMeta.get(jid);

    const p = (async () => {
        try {
            const meta = await sock.groupMetadata(jid);
            capMap(groupMetaCache, jid, { ts: Date.now(), meta }, 150);
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

function trimCaches() {
    if (messageStore.size > 400) {
        const excess = messageStore.size - 400;
        let i = 0;
        for (const k of messageStore.keys()) {
            messageStore.delete(k);
            if (++i >= excess) break;
        }
    }
    if (antideleteCache.size > 150) antideleteCache.clear();
    if (groupMetaCache.size > 50) groupMetaCache.clear();
    if (processedMsgIds.size > 1000) processedMsgIds.clear();
    clearTtlCache();
}

// ═════════════════════════════════════════════════════════════
// 1. MONGODB ATLAS LEAN AUTH BACKUP & AUTO-RECOVERY
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
        .slice(0, 60);
    const senderKeys = filenames.filter((f) => f.startsWith('sender-key-') && !f.startsWith('sender-key-memory-')).slice(0, 120);
    const chatSessions = filenames.filter((f) => f.startsWith('session-')).slice(0, 120);
    const identityKeys = filenames.filter((f) => f.startsWith('identity-')).slice(0, 60);

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

async function restoreSessionFromCloud(force = false) {
    try {
        const credsFile = path.join(SESSION_DIR, 'creds.json');
        if (!force && fs.existsSync(credsFile)) {
            const rawLocal = await fs.readFile(credsFile, 'utf8').catch(() => '');
            if (isRegisteredCredsJson(rawLocal)) {
                console.log('📂 [Session] Local registered session found on disk.');
                return true;
            }
            console.log('🧹 [Session] Removing incomplete/unregistered local creds.json...');
            await fs.emptyDir(SESSION_DIR).catch(() => {});
        }
        const db = await initMongo();
        if (!db) return false;

        const doc = await db.collection('mini_bot_auth').findOne({ _id: 'primary_session' });
        if (!doc?.data) {
            console.log('ℹ️ [Session] No cloud backup found in Atlas.');
            return false;
        }

        let buffer;
        if (Buffer.isBuffer(doc.data)) buffer = doc.data;
        else if (doc.data?.buffer) buffer = Buffer.from(doc.data.buffer);
        else buffer = Buffer.from(doc.data, 'base64');

        const rawMapBuf = await gunzipAsync(buffer);
        const filesMap = JSON.parse(rawMapBuf.toString('utf8'));
        if (!filesMap['creds.json'] || !isRegisteredCredsJson(filesMap['creds.json'])) {
            console.log('ℹ️ [Session] Ignoring unregistered cloud backup; waiting for fresh pair.');
            return false;
        }

        await fs.ensureDir(SESSION_DIR);
        for (const [filename, content] of Object.entries(filesMap)) {
            const safeName = path.basename(filename);
            await fs.writeFile(path.join(SESSION_DIR, safeName), String(content), 'utf8');
        }
        console.log(`📥 [Session] Restored ${Object.keys(filesMap).length} auth files from MongoDB Atlas.`);
        return true;
    } catch (e) {
        console.warn('⚠️ [Session Restore Error]:', e.message);
        resetMongoOnError(e);
        return false;
    }
}

async function executeCloudBackupNow() {
    if (!MONGODB_URI || backupInFlight) return false;
    backupInFlight = true;
    try {
        const credsFile = path.join(SESSION_DIR, 'creds.json');
        if (!fs.existsSync(credsFile)) return false;
        const rawCreds = await fs.readFile(credsFile, 'utf8').catch(() => '');
        if (!isRegisteredCredsJson(rawCreds)) return false;

        const allFiles = await fs.readdir(SESSION_DIR);
        const leanSet = filterLeanSessionFiles(allFiles);
        const filesMap = {};
        await Promise.all(Array.from(leanSet).map(async (f) => {
            const fp = path.join(SESSION_DIR, f);
            const stat = await fs.stat(fp).catch(() => null);
            if (stat?.isFile()) {
                filesMap[f] = await fs.readFile(fp, 'utf8');
            }
        }));
        if (!filesMap['creds.json']) return false;

        const payloadBuf = Buffer.from(JSON.stringify(filesMap), 'utf8');
        const currentHash = crypto.createHash('sha1').update(payloadBuf).digest('hex');
        if (currentHash === lastBackupHash) return true;

        const compressed = await gzipAsync(payloadBuf);
        const db = await initMongo();
        if (!db) return false;

        await db.collection('mini_bot_auth').updateOne(
            { _id: 'primary_session' },
            {
                $set: {
                    _id: 'primary_session',
                    data: compressed,
                    fileCount: Object.keys(filesMap).length,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        lastBackupHash = currentHash;
        return true;
    } catch (e) {
        console.warn('⚠️ [Session Backup Error]:', e.message);
        resetMongoOnError(e);
        return false;
    } finally {
        backupInFlight = false;
    }
}

function backupSessionToCloud() {
    if (!MONGODB_URI) return;
    if (backupDebounceTimer) clearTimeout(backupDebounceTimer);
    backupDebounceTimer = setTimeout(() => {
        executeCloudBackupNow().catch(() => {});
    }, 25000);
}

// ═════════════════════════════════════════════════════════════
// 2. WHATSAPP BAILEYS v7 CLIENT & EVENT ROUTER
// ═════════════════════════════════════════════════════════════

function cleanupActiveSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (sock) {
        try { sock.ev.removeAllListeners(); } catch (_) {}
        try { sock.ws?.close?.(); } catch (_) {}
        try { sock.ws?.socket?.terminate?.(); } catch (_) {}
        sock = null;
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function initWhatsApp(pairingNumber = null) {
    if (isConnecting) {
        if (Date.now() - connectStartedAt < 45000) {
            return currentPairingCode;
        }
        console.warn('⚠️ [Connect Watchdog] Resetting stuck connection lock...');
        isConnecting = false;
    }

    isConnecting = true;
    connectStartedAt = Date.now();
    currentPairingCode = null;

    try {
        cleanupActiveSocket();

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

        const originalKeysSet = state.keys.set;
        state.keys.set = async (data) => {
            await originalKeysSet(data);
            backupSessionToCloud();
        };

        if (!versionRefreshStarted) {
            versionRefreshStarted = true;
            fetchLatestBaileysVersion()
                .then((fetched) => {
                    if (Array.isArray(fetched?.version)) cachedBaileysVersion = fetched.version;
                })
                .catch(() => {});
        }

        console.log(`🚀 [Baileys] Booting WASocket (WA v${cachedBaileysVersion.join('.')})...`);

        sock = makeWASocket({
            version: cachedBaileysVersion,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            fireInitQueries: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 25000,
            defaultQueryTimeoutMs: 20000,
            emitOwnEvents: true,
            retryRequestDelayMs: 600,
            maxMsgRetryCount: 5,
            generateHighQualityLinkPreview: false,
            cachedGroupMetadata: async (jid) => getCachedGroupMeta(jid),
            getMessage: async (key) => {
                if (!key || key.remoteJid?.endsWith('@newsletter')) return undefined;
                if (key.id && messageStore.has(key.id)) return messageStore.get(key.id);
                if (key.remoteJid && key.id && messageStore.has(`${key.remoteJid}:${key.id}`)) {
                    return messageStore.get(`${key.remoteJid}:${key.id}`);
                }
                return undefined;
            }
        });

        // Safe-Send wrapper: routes self-chat cleanly to phone JID & strips self-quotes to prevent E2EE stalls
        const rawSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options = {}) => {
            const botPn = cachedBotPn || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
            const botLid = cachedBotLid || (sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : null);
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

            // Attach WhatsApp "Forwarded / View Channel" newsletter pill on replies & media
            const cfg = configStore.getConfig();
            const isNewsletterDest = targetJid && targetJid.endsWith('@newsletter');
            const isStatusDest = targetJid === 'status@broadcast';
            const supportsChannelCard = Boolean(
                content &&
                typeof content === 'object' &&
                !content.react &&
                !content.delete &&
                !content.poll &&
                !content.edit &&
                (content.text !== undefined || content.image || content.video || content.audio || content.document)
            );
            if (cfg.channelCardEnabled && cfg.newsletterJid && !isNewsletterDest && !isStatusDest && supportsChannelCard) {
                const existingCtx = (content.contextInfo && typeof content.contextInfo === 'object') ? content.contextInfo : {};
                content = {
                    ...content,
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: cfg.newsletterJid,
                            newsletterName: cfg.newsletterName || cfg.botName || 'SIGMA MD',
                            serverMessageId: 1
                        },
                        ...existingCtx
                    }
                };
            }

            const sentMsg = await rawSendMessage(jid, content, options);
            cacheMessage(sentMsg);
            return sentMsg;
        };

        // ALWAYS register ALL event listeners BEFORE calling requestPairingCode!
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                backupSessionToCloud();
            } catch (_) {}
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
                isConnected = false;
                isConnecting = false;
                cachedBotPn = null;
                cachedBotLid = null;
                cachedBotDigits = '';

                console.log(`⚠️ [Connection Closed] Status: ${statusCode || 'unknown'}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    consecutive401Count++;
                    if (consecutive401Count < 3 && fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
                        console.warn(`🛡️ [401 Shield] Transient 401 #${consecutive401Count}/3 — restoring & retrying...`);
                        await restoreSessionFromCloud(true).catch(() => {});
                        reconnectTimer = setTimeout(() => initWhatsApp().catch(() => {}), consecutive401Count * 5000);
                        return;
                    }
                    console.log('🔴 [LoggedOut] Session revoked after repeated 401. Clearing local session...');
                    try { await fs.emptyDir(SESSION_DIR); } catch (_) {}
                } else {
                    consecutive401Count = 0;
                    const waitMs = statusCode === DisconnectReason.restartRequired ? 1500 : 4000;
                    reconnectTimer = setTimeout(() => initWhatsApp().catch(() => {}), waitMs);
                }
            } else if (connection === 'open') {
                isConnected = true;
                isConnecting = false;
                consecutive401Count = 0;
                currentPairingCode = null;

                const cfg = configStore.getConfig();
                cachedBotPn = jidNormalizedUser(sock.user.id);
                cachedBotLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
                cachedBotDigits = configStore.normalizeDigits(cachedBotPn);
                const botJid = cachedBotPn;
                const totalCmds = registry.getAllCommands().length;

                console.log(`🟢 [CONNECTED] ${cfg.botName} ONLINE as ${botJid} (${totalCmds} commands | RAM ${getMemoryUsageMb()}MB)`);

                // Send startup confirmation cleanly
                try {
                    await sock.sendMessage(botJid, {
                        text: `╭━━━〔 ⚡ *${cfg.botName} ONLINE* ⚡ 〕━━━┈⊷\n` +
                              `┃ 🟢 *Status:* Connected (Baileys v7)\n` +
                              `┃ 🛠️ *Commands:* ${totalCmds}+ Loaded\n` +
                              `┃ 💾 *RAM:* ${getMemoryUsageMb()} MB / 512 MB\n` +
                              `┃ ⏱️ *KeepAlive:* 25s Zero-Sleep Active\n` +
                              `┃ 🤖 *Mini Bot Pair:* ${cfg.miniPairUrl || 'https://sigmamini.vercel.app'}\n` +
                              `┃ ⚡ *Main Bot Pair:* ${cfg.mainPairUrl || 'https://mrsaqib.me/pair'}\n` +
                              `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                              `_Type *${cfg.prefix}menu* ya *${cfg.prefix}profile* to explore!_`
                    });
                } catch (_) {}

                backupSessionToCloud();

                // Background pre-upload menu artwork so .menu / .owner deliver in <60ms!
                setTimeout(() => {
                    warmMenuMedia(sock).catch(() => {});
                }, 3000);

                // Background auto-follow configured channels if any
                if (Array.isArray(cfg.autoFollowChannels) && cfg.autoFollowChannels.length > 0) {
                    setTimeout(async () => {
                        for (const ch of cfg.autoFollowChannels) {
                            try {
                                await sock?.newsletterFollow?.(ch.jid);
                                await sleep(800);
                            } catch (_) {}
                        }
                    }, 12000);
                }
            }
        });

        const callNoticeCooldown = new Map();
        sock.ev.on('call', async (calls) => {
            if (!configStore.getConfig().anticall || !Array.isArray(calls)) return;
            for (const call of calls) {
                if (call?.status !== 'offer' || !call?.id || !call?.from) continue;
                try {
                    await sock.rejectCall(call.id, call.from).catch(() => {});
                    const lastNotice = callNoticeCooldown.get(call.from) || 0;
                    if (Date.now() - lastNotice > 30000) {
                        capSet(callNoticeCooldown, call.from, 100);
                        callNoticeCooldown.set(call.from, Date.now());
                        await sock.sendMessage(call.from, {
                            text: '🚫 *Auto Call Reject Active!*\nCalls allow nahi hain. Baraye meharbani sirf text message bhejein.'
                        }).catch(() => {});
                    }
                } catch (_) {}
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

                const meta = await getCachedGroupMeta(groupJid);
                const groupName = meta?.subject || 'this group';
                for (const rawParticipant of participants) {
                    const pJid = typeof rawParticipant === 'string' ? rawParticipant : rawParticipant?.id;
                    if (!pJid) continue;
                    const tag = `@${pJid.split('@')[0]}`;
                    const template = action === 'add'
                        ? (gs.welcomeText || `👋 Khush Amdeed ${tag} in *${groupName}*!`)
                        : (gs.goodbyeText || `👋 Allah Hafiz ${tag}!`);
                    const finalMsg = template.replace(/@user/gi, tag).replace(/@group/gi, groupName);
                    await sock.sendMessage(groupJid, { text: finalMsg, mentions: [pJid] }).catch(() => {});
                }
            } catch (_) {}
        });

        function getPrefixRegex(activePrefix) {
            if (cachedPrefixRegex && cachedPrefixKey === activePrefix) return cachedPrefixRegex;
            cachedPrefixKey = activePrefix;
            cachedPrefixRegex = new RegExp(`^(${escapeRegExp(activePrefix)})\\s*([a-zA-Z0-9_-]+)([\\s\\S]*)$`);
            return cachedPrefixRegex;
        }

        async function handleSingleIncomingMessage(msg) {
            try {
                if (!msg?.message || !msg.key) return;
                const msgId = msg.key.id;
                if (msgId && processedMsgIds.has(msgId)) return;
                if (msgId) capSet(processedMsgIds, msgId, 1500);

                cacheMessage(msg);
                const cfg = configStore.getConfig();

                if (msg.key.remoteJid === 'status@broadcast') {
                    if (cfg.autoviewStatus && !msg.key.fromMe) {
                        sock.readMessages([msg.key]).catch(() => {});
                    }
                    if (!msg.message?.deviceSentMessage?.destinationJid) return;
                }

                if (msg.key.remoteJid?.endsWith('@newsletter')) return;

                const protoMsg = msg.message?.protocolMessage;
                if (protoMsg?.type === 0 && cfg.antidelete) {
                    const revokedId = protoMsg.key?.id;
                    const cached = revokedId ? antideleteCache.get(revokedId) : null;
                    const botPn = cachedBotPn || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
                    if (cached && botPn) {
                        await sock.sendMessage(botPn, {
                            text: `🛡️ *ANTI-DELETE RECOVERED*\n👤 *From:* ${cached.chat}\n📱 *Sender:* +${cached.sender}\n\n📝 *Message:*\n${cached.text || '[Media / Non-Text]'}`
                        }).catch(() => {});
                    }
                    return;
                }

                const botPn = cachedBotPn || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
                const botLid = cachedBotLid || (sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : null);
                const botDigits = cachedBotDigits || configStore.normalizeDigits(botPn);

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
                if (cfg.autovv && isViewOnceMsg && !isFromMe && botPn) {
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
                if (!rawText) return;

                // Ultra-fast synchronous gate BEFORE fetching groupMetadata or resolving LIDs
                const cleanText = rawText.replace(/[\u200e\u200f\u200b\u200c\u200d\u2060\ufeff]/g, '').trim();
                const activePrefix = cfg.prefix || '.';
                const match = cleanText.match(getPrefixRegex(activePrefix));
                const gs = isGroup ? configStore.getGroupSettings(from) : null;
                const hasLinkViolation = Boolean(
                    isGroup && gs?.antilink && !isFromMe && /(https?:\/\/)?(chat\.whatsapp\.com|whatsapp\.com\/channel)\/\S+/i.test(rawText)
                );

                if (cfg.antidelete && msgId && !isFromMe) {
                    capMap(antideleteCache, msgId, { chat: from, sender: msg.key.participant?.split('@')[0] || from.split('@')[0], text: rawText }, 500);
                }

                if (!match && !hasLinkViolation) return;

                const cmd = match ? registry.findCommand(match[2].toLowerCase()) : null;
                if (!cmd && !hasLinkViolation) return;

                const msgTime = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();
                if (Date.now() - msgTime > 120000) return;

                // Resolve groupMetadata ONLY when actually needed (group commands, antilink, or @lid fallback)
                const senderRawJid = isGroup ? (msg.key.participant || from) : from;
                const altPn = isGroup ? (msg.key.participantAlt || msg.participantPn) : (msg.key.remoteJidAlt || msg.key.participantAlt);
                const needsGroupMeta = isGroup && (hasLinkViolation || cmd?.category === 'group' || (senderRawJid.endsWith('@lid') && !altPn?.endsWith('@s.whatsapp.net')));
                const groupMeta = needsGroupMeta ? await getCachedGroupMeta(from) : null;

                let senderDigits = '';
                if (isFromMe && botDigits) {
                    senderDigits = botDigits;
                } else if (!isGroup && from.endsWith('@s.whatsapp.net')) {
                    senderDigits = configStore.normalizeDigits(from);
                } else {
                    senderDigits = await resolveSenderDigits(sock, msg, groupMeta);
                }
                const isOwner = isFromMe || configStore.isOwnerDigits(senderDigits) || (botDigits && senderDigits === botDigits);

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
                if (cfg.mode !== 'public' && !isOwner) return;
                if (!isOwner && configStore.isBannedDigits(senderDigits)) return;

                if (cfg.autoread && !isFromMe) sock.readMessages([msg.key]).catch(() => {});
                if (cfg.autotyping) sock.sendPresenceUpdate('composing', from).catch(() => {});
                else if (cfg.autorecord) sock.sendPresenceUpdate('recording', from).catch(() => {});

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
                        forceCloudBackup: executeCloudBackupNow
                    },
                    reply: (text) => sock.sendMessage(from, { text }, quoteOpt),
                    react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {})
                };

                try {
                    await cmd.handler(ctx);
                } catch (execErr) {
                    console.error(`❌ [CMD ${commandName}]:`, execErr.message);
                    ctx.react('❌');
                    await ctx.reply(`❌ *Error (${commandName}):* ${execErr.message}`).catch(() => {});
                }
            } catch (loopErr) {
                console.error('❌ [Message Handler Error]:', loopErr.message);
            }
        }

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify' || !Array.isArray(messages) || messages.length === 0) return;
            for (const msg of messages) {
                void handleSingleIncomingMessage(msg);
            }
        });

        // Pairing Code generation (safe because all listeners are ALREADY attached above!)
        if (pairingNumber && !sock.authState.creds.registered) {
            const clean = pairingNumber.replace(/[^0-9]/g, '');
            await delayOrSleep(500);
            const code = await sock.requestPairingCode(clean);
            currentPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`🔑 [Pairing Code] +${clean} => ${currentPairingCode}`);
            isConnecting = false;
            return currentPairingCode;
        }

        isConnecting = false;
        return null;
    } catch (err) {
        isConnecting = false;
        console.error('❌ [WhatsApp Init Error]:', err.message);
        throw err;
    }
}

function delayOrSleep(ms) {
    return sleep(ms);
}

// ═════════════════════════════════════════════════════════════
// 3. 24/7 KEEPALIVE, SOCKET WATCHDOG & MEMORY ENGINE
// ═════════════════════════════════════════════════════════════

async function pingPublicKeepAlive() {
    try {
        const myUrl = process.env.APP_URL || (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : null);
        if (myUrl && !myUrl.includes('localhost') && !myUrl.includes('127.0.0.1')) {
            const cleanUrl = myUrl.replace(/\/+$/, '');
            await httpClient.get(`${cleanUrl}/health`, {
                timeout: 5000,
                headers: { 'User-Agent': 'MiniBot-ZeroSleep/2.0' }
            }).catch(() => null);
        }
    } catch (_) {}
}

setInterval(pingPublicKeepAlive, 25 * 1000);

setInterval(() => {
    if (sock && isConnected) {
        const isWsOpen = Boolean(sock.ws?.isOpen || sock.ws?.socket?.readyState === 1);
        if (!isWsOpen) {
            console.warn('⚠️ [Watchdog] WebSocket stale. Reconnecting...');
            isConnected = false;
            initWhatsApp().catch(() => {});
        }
    }
}, 30 * 1000);

setInterval(() => {
    const memMb = getMemoryUsageMb();
    if (memMb > 130) {
        trimCaches();
        if (global.gc) {
            try { global.gc(); } catch (_) {}
        }
    }
}, 30 * 1000);

setInterval(() => {
    if (isConnected) backupSessionToCloud();
}, 60 * 1000);

// ═════════════════════════════════════════════════════════════
// 4. EXPRESS WEB DASHBOARD & PAIRING API
// ═════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));

app.get('/menu-preview', (req, res) => {
    const imgBuf = getMenuImageBuffer();
    if (!imgBuf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(imgBuf);
});

app.get(['/health', '/ping'], (req, res) => {
    const cfg = configStore.getConfig();
    res.json({
        status: 'ok',
        botName: cfg.botName,
        connected: isConnected,
        totalCommands: registry.getAllCommands().length,
        uptimeSeconds: getUptimeSec(),
        ramUsageMb: getMemoryUsageMb(),
        timestamp: Date.now()
    });
});

app.get(['/pair', '/code', '/api/pair'], async (req, res) => {
    const rawNumber = (req.query.number || req.query.phone || '').toString().trim();
    const force = req.query.force === '1' || req.query.force === 'true';

    if (!rawNumber) {
        return res.status(400).json({ success: false, error: 'Phone number required. Example: /pair?number=923438673242' });
    }
    let cleanNumber = rawNumber.replace(/[^0-9]/g, '');
    if (cleanNumber.startsWith('00')) cleanNumber = cleanNumber.slice(2);
    else if (cleanNumber.startsWith('0')) cleanNumber = '92' + cleanNumber.slice(1);
    else if (cleanNumber.startsWith('3') && cleanNumber.length === 10) cleanNumber = '92' + cleanNumber;
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, error: 'Invalid phone number format.' });
    }
    if (isConnected && !force) {
        const currentDigits = configStore.normalizeDigits(sock?.user?.id);
        return res.status(409).json({
            success: false,
            error: `Bot already connected (+${currentDigits}). Pass ?force=true to re-pair.`
        });
    }
    if (isConnecting && !force) {
        return res.status(429).json({
            success: false,
            error: 'Pairing or connection attempt already in progress. Retry in a few seconds.'
        });
    }

    try {
        console.log(`📱 [Web Pair] Generating pairing code for +${cleanNumber}`);
        isConnecting = false;
        isConnected = false;
        consecutive401Count = 0;
        cleanupActiveSocket();
        await fs.emptyDir(SESSION_DIR);

        const code = await initWhatsApp(cleanNumber);
        if (!code) {
            return res.status(503).json({ success: false, error: 'Could not generate pairing code. Please try again.' });
        }
        return res.json({
            success: true,
            number: cleanNumber,
            pairingCode: code,
            instructions: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with Phone Number'
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Pairing failed: ' + (e.message || 'Unknown error') });
    }
});

app.get('/', (req, res) => {
    const cfg = configStore.getConfig();
    const botNameHtml = escapeHtml(cfg.botName || 'SIGMA MD');
    const ownerNameHtml = escapeHtml(cfg.ownerName);
    const ownerNumberHtml = escapeHtml(cfg.owners[0] || '923438673242');
    const miniPairHref = escapeHtml(cfg.miniPairUrl || 'https://sigmamini.vercel.app');
    const mainPairHref = escapeHtml(cfg.mainPairUrl || 'https://mrsaqib.me/pair');
    const totalCmds = registry.getAllCommands().length;
    const memMb = getMemoryUsageMb();
    const uptimeStr = formatUptime(getUptimeSec());
    const statusColor = isConnected ? '#10b981' : (isConnecting ? '#f59e0b' : '#ef4444');
    const statusText = isConnected ? 'ONLINE & CONNECTED' : (isConnecting ? 'CONNECTING...' : 'OFFLINE / READY TO PAIR');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${botNameHtml} — 24/7 Zero-Sleep</title>
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
        .avatar-wrap {
            position: relative;
            margin: -54px auto 12px;
            width: 108px;
            height: 108px;
            z-index: 2;
        }
        .avatar-ring {
            width: 108px;
            height: 108px;
            border-radius: 50%;
            padding: 3px;
            background: linear-gradient(135deg, #38bdf8, #3b82f6, #10b981);
            box-shadow: 0 0 24px rgba(56, 189, 248, 0.45);
        }
        .avatar-ring img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 50%;
            display: block;
            border: 3px solid #0b1120;
        }
        .status-orb {
            position: absolute;
            right: 5px;
            bottom: 5px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: ${statusColor};
            border: 3px solid #0b1120;
            box-shadow: 0 0 12px ${statusColor};
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 14px;
            border-radius: 999px;
            font-size: 11px;
            letter-spacing: 0.6px;
            font-weight: 700;
            background: rgba(15, 23, 42, 0.85);
            border: 1px solid rgba(56, 189, 248, 0.25);
            margin-bottom: 12px;
            color: #e2e8f0;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 10px ${statusColor}; }
        h1 { font-size: 25px; font-weight: 800; letter-spacing: 0.4px; margin-bottom: 4px; background: linear-gradient(90deg, #ffffff, #7dd3fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p.sub { color: #94a3b8; font-size: 13px; margin-bottom: 18px; }
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
        .stat-box { background: rgba(30,41,59,0.55); border: 1px solid rgba(56,189,248,0.12); padding: 12px 8px; border-radius: 14px; }
        .stat-val { font-size: 16px; font-weight: 800; color: #38bdf8; font-family: monospace; }
        .stat-lbl { font-size: 10px; color: #94a3b8; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
        .form-group { display: flex; flex-direction: column; gap: 10px; text-align: left; }
        label { font-size: 12px; font-weight: 600; color: #cbd5e1; }
        input { width: 100%; padding: 13px 15px; border-radius: 12px; background: rgba(15,23,42,0.9); border: 1px solid rgba(56,189,248,0.22); color: #fff; font-size: 15px; font-family: monospace; outline: none; transition: border-color .2s; }
        input:focus { border-color: #38bdf8; }
        button { width: 100%; padding: 14px; border-radius: 12px; background: linear-gradient(135deg, #0ea5e9, #2563eb); color: #fff; font-size: 15px; font-weight: 700; border: none; cursor: pointer; margin-top: 2px; box-shadow: 0 8px 20px -6px rgba(14,165,233,0.45); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .code-box { display: none; margin-top: 16px; padding: 16px; background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.35); border-radius: 14px; }
        .code-val { font-family: monospace; font-size: 30px; font-weight: 800; letter-spacing: 3px; color: #4ade80; margin: 8px 0; }
        .art-preview { margin-top: 16px; border-radius: 14px; overflow: hidden; border: 1px solid rgba(56,189,248,0.18); background: #060a14; }
        .art-preview summary { cursor: pointer; padding: 9px 12px; font-size: 12px; font-weight: 600; color: #7dd3fc; list-style: none; user-select: none; }
        .art-preview img { width: 100%; display: block; border-top: 1px solid rgba(255,255,255,0.08); }
        .footer { margin-top: 18px; font-size: 11px; color: #64748b; }
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
        <p class="sub">Created by ${ownerNameHtml} &bull; ${totalCmds}+ Commands &bull; Zero-Sleep</p>
        <div class="stats-grid">
            <div class="stat-box"><div class="stat-val">${memMb}M</div><div class="stat-lbl">RAM</div></div>
            <div class="stat-box"><div class="stat-val">${uptimeStr}</div><div class="stat-lbl">Uptime</div></div>
            <div class="stat-box"><div class="stat-val">${totalCmds}+</div><div class="stat-lbl">Commands</div></div>
        </div>
        <div class="form-group">
            <label for="phone">WhatsApp Number with Country Code:</label>
            <input type="tel" id="phone" placeholder="923438673242" value="${ownerNumberHtml}">
            <button id="btnPair" onclick="getPairingCode()">🔗 Get WhatsApp Pairing Code</button>
        </div>
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
            <a href="${miniPairHref}" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(56,189,248,0.3); background: rgba(56,189,248,0.08);">🤖 Mini Bot Pair</a>
            <a href="${mainPairHref}" target="_blank" rel="noopener noreferrer" style="color: #34d399; text-decoration: none; padding: 6px 12px; border-radius: 999px; border: 1px solid rgba(52,211,153,0.3); background: rgba(52,211,153,0.08);">⚡ Main Bot Pair</a>
        </div>
        <div class="footer">${botNameHtml} • Built by ${ownerNameHtml} &bull; Heroku 24/7 Engine</div>
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
// 5. BOOTSTRAP
// ═════════════════════════════════════════════════════════════

app.listen(PORT, async () => {
    await configStore.loadConfig().catch(() => {});
    const cfg = configStore.getConfig();
    console.log(`\n======================================================`);
    console.log(`⚡ ${cfg.botName} v2.0 RUNNING ON PORT ${PORT}`);
    console.log(`🛠️ Loaded Commands: ${registry.getAllCommands().length} across ${registry.getCategories().length} categories`);
    console.log(`💾 Initial RAM: ${getMemoryUsageMb()} MB / 512 MB`);
    console.log(`======================================================\n`);

    const credsFile = path.join(SESSION_DIR, 'creds.json');
    const localCredsRaw = fs.existsSync(credsFile) ? await fs.readFile(credsFile, 'utf8').catch(() => '') : '';

    if (isRegisteredCredsJson(localCredsRaw)) {
        // Zero-wait boot: connect WhatsApp immediately while syncing MongoDB in background!
        console.log('🔑 [Auth] Local registered credentials detected. Connecting immediately...');
        initWhatsApp().catch((err) => console.error('❌ [Auto-Connect Error]:', err.message));
        initMongo().then((db) => db && configStore.loadConfig(db)).catch(() => {});
        return;
    }

    await initMongo().then((db) => db && configStore.loadConfig(db)).catch(() => {});
    await restoreSessionFromCloud();
    const restoredRaw = fs.existsSync(credsFile) ? await fs.readFile(credsFile, 'utf8').catch(() => '') : '';
    if (isRegisteredCredsJson(restoredRaw)) {
        console.log('🔑 [Auth] Restored registered credentials. Connecting to WhatsApp...');
        initWhatsApp().catch((err) => console.error('❌ [Auto-Connect Error]:', err.message));
    } else {
        console.log('ℹ️ [Auth] No registered session yet. Open Web Dashboard to pair.');
    }
});
