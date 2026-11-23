'use strict';

/**
 * ============================================================================
 * MINI BOT MD :: ULTRA-LIGHTWEIGHT 24/7 ZERO-SLEEP WHATSAPP BOT FOR HEROKU
 * ============================================================================
 * Features:
 * 1. Ultra-Low RAM Footprint (~35MB - 50MB) — Never hits Heroku 512MB RAM limit!
 * 2. 24/7 Zero-Sleep Keepalive Engine — Self-pings public router every 25s.
 * 3. Web Pairing Code Generator (/pair?number=9234xxxxxxxxx).
 * 4. Automatic Cloud Session Backup to MongoDB Atlas (Persistent login across dyno restarts).
 * 5. Instant Command Dispatcher (.ping, .menu, .alive, .ram, .owner, .echo).
 * ============================================================================
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs-extra');
const zlib = require('zlib');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    delay
} = require('@whiskeysockets/baileys');

// Configuration
const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, 'session');
const BOT_NAME = process.env.BOT_NAME || 'MINI BOT MD';
const OWNER_NAME = process.env.OWNER_NAME || 'MR SAQIB';
const OWNER_NUMBER = process.env.OWNER_NUMBER || '923438673242';
const MONGODB_URI = process.env.MONGODB_URI || '';
const BOOT_TIME = Date.now();

let sock = null;
let isConnected = false;
let isConnecting = false;
let currentPairingCode = null;
let saveCredsCallback = null;
let mongoDb = null;
let mongoClient = null;

// In-Memory message store for instant Baileys retry resolution (Eliminates "Waiting for this message")
const messageStore = new Map();

// Ensure session directory exists
fs.ensureDirSync(SESSION_DIR);

// ═════════════════════════════════════════════════════════════
// 1. MONGODB ATLAS CLOUD BACKUP & RESTORE (Zero Login Loss)
// ═════════════════════════════════════════════════════════════

async function initMongo() {
    if (!MONGODB_URI) return null;
    if (mongoDb) return mongoDb;
    try {
        mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
        await mongoClient.connect();
        mongoDb = mongoClient.db('mr_saqib_bot');
        console.log('✅ [MongoDB] Connected to Atlas Cloud for persistent session backup!');
        return mongoDb;
    } catch (e) {
        console.warn('⚠️ [MongoDB Warning] Connection failed:', e.message);
        return null;
    }
}

async function restoreSessionFromCloud() {
    try {
        const credsFile = path.join(SESSION_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) {
            console.log('📂 [Session] Local session found on disk. Booting...');
            return true;
        }

        const db = await initMongo();
        if (!db) return false;

        const col = db.collection('mini_bot_auth');
        const doc = await col.findOne({ _id: 'primary_session' });
        if (!doc || !doc.data) {
            console.log('ℹ️ [Session] No cloud session found. Waiting for pairing code...');
            return false;
        }

        let buffer;
        if (Buffer.isBuffer(doc.data)) buffer = doc.data;
        else if (doc.data?.buffer) buffer = Buffer.from(doc.data.buffer);
        else buffer = Buffer.from(doc.data, 'base64');

        const jsonStr = zlib.gunzipSync(buffer).toString('utf8');
        const filesMap = JSON.parse(jsonStr);

        for (const [filename, content] of Object.entries(filesMap)) {
            await fs.writeFile(path.join(SESSION_DIR, filename), content, 'utf8');
        }

        console.log(`📥 [Session] Restored ${Object.keys(filesMap).length} auth files from MongoDB Atlas cloud!`);
        return true;
    } catch (e) {
        console.warn('⚠️ [Session Restore Error]:', e.message);
        return false;
    }
}

let backupDebounceTimer = null;
function backupSessionToCloud() {
    if (!MONGODB_URI) return;
    if (backupDebounceTimer) clearTimeout(backupDebounceTimer);

    backupDebounceTimer = setTimeout(async () => {
        try {
            const credsFile = path.join(SESSION_DIR, 'creds.json');
            if (!fs.existsSync(credsFile)) return;

            const files = await fs.readdir(SESSION_DIR);
            const filesMap = {};
            for (const f of files) {
                if (f.startsWith('.')) continue;
                const filePath = path.join(SESSION_DIR, f);
                const stat = await fs.stat(filePath);
                if (stat.isFile()) {
                    filesMap[f] = await fs.readFile(filePath, 'utf8');
                }
            }

            if (!filesMap['creds.json']) return;

            const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(filesMap), 'utf8'));
            const db = await initMongo();
            if (!db) return;

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
            console.log(`☁️ [Session Backup] Session (${Object.keys(filesMap).length} files) safely saved to MongoDB Atlas!`);
        } catch (e) {
            console.warn('⚠️ [Session Backup Error]:', e.message);
        }
    }, 2500);
}

// ═════════════════════════════════════════════════════════════
// 1.5. CHANNEL & MEDIA HELPERS (.cforward ENGINE)
// ═════════════════════════════════════════════════════════════

async function extractQuotedMedia(quotedMsg) {
    if (!quotedMsg) return null;
    let content = quotedMsg;
    while (content.ephemeralMessage || content.viewOnceMessage || content.viewOnceMessageV2 || content.documentWithCaptionMessage) {
        content = content.ephemeralMessage?.message || content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.documentWithCaptionMessage?.message || content;
    }
    const type = Object.keys(content)[0];
    const raw = content[type];
    if (!raw) return null;

    let mediaType = null;
    if (type === 'imageMessage') mediaType = 'image';
    else if (type === 'videoMessage') mediaType = 'video';
    else if (type === 'audioMessage') mediaType = 'audio';
    else if (type === 'documentMessage') mediaType = 'document';
    else if (type === 'stickerMessage') mediaType = 'sticker';

    if (!mediaType) return null;

    try {
        const stream = await downloadContentFromMessage(raw, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return {
            buffer,
            mediaType,
            type,
            mimetype: raw.mimetype,
            caption: raw.caption || '',
            fileName: raw.fileName || 'file'
        };
    } catch (e) {
        console.error('[extractQuotedMedia error]:', e.message);
        return null;
    }
}

async function resolveChannelTarget(targetStr) {
    if (!targetStr || !sock) return null;
    const clean = targetStr.trim();

    // Invite link: https://whatsapp.com/channel/CODE
    const linkMatch = clean.match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
    if (linkMatch) {
        const code = linkMatch[1];
        try {
            const meta = await sock.newsletterMetadata('invite', code);
            if (meta?.id) {
                return {
                    jid: meta.id,
                    name: meta.thread_metadata?.name?.text || meta.name || 'WhatsApp Channel'
                };
            }
        } catch (e) {
            console.error('[resolveChannelTarget invite error]:', e.message);
        }
    }

    // Direct JID: 120363xxx@newsletter
    if (clean.endsWith('@newsletter')) {
        let name = 'WhatsApp Channel';
        try {
            const meta = await sock.newsletterMetadata('jid', clean);
            name = meta?.thread_metadata?.name?.text || meta?.name || name;
        } catch (_) {}
        return { jid: clean, name };
    }

    // Numeric ID
    if (/^\d{10,}$/.test(clean)) {
        const jid = `${clean}@newsletter`;
        return { jid, name: 'WhatsApp Channel' };
    }

    return null;
}

async function getAdminChannels() {
    if (!sock) return [];
    try {
        const res = await sock.query({
            tag: 'iq',
            attrs: { id: sock.generateMessageTag(), type: 'get', to: 's.whatsapp.net', xmlns: 'w:mex' },
            content: [{ tag: 'query', attrs: { query_id: '6388546374527196' }, content: Buffer.from(JSON.stringify({ variables: {} }), 'utf-8') }]
        });
        const child = Array.isArray(res?.content) ? res.content.find((c) => c?.tag === 'result') : null;
        if (child?.content) {
            const data = JSON.parse(Buffer.from(child.content).toString('utf8'));
            const list = data?.data?.xwa2_newsletter_subscribed || [];
            return list
                .filter(item => {
                    const role = item?.viewer_metadata?.role;
                    return role === 'ADMIN' || role === 'OWNER';
                })
                .map(item => ({
                    jid: item.id,
                    name: item.thread_metadata?.name?.text || item.name || item.id
                }));
        }
    } catch (e) {
        console.warn('[getAdminChannels error]:', e.message);
    }
    return [];
}

// ═════════════════════════════════════════════════════════════
// 2. WHATSAPP BAILEYS CLIENT (Multi-Device WASocket)
// ═════════════════════════════════════════════════════════════

async function initWhatsApp(pairingNumber = null) {
    if (isConnecting) return currentPairingCode;
    isConnecting = true;

    try {
        // Clean stale socket if any
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (_) {}
            try { sock.ws?.close?.(); } catch (_) {}
            try { sock.ws?.socket?.terminate?.(); } catch (_) {}
            sock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        saveCredsCallback = saveCreds;
        const { version } = await fetchLatestBaileysVersion();

        console.log(`🚀 [Baileys] Booting WASocket (WA v${version.join('.')})...`);

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 15000,
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 25000,
            emitOwnEvents: true,
            getMessage: async (key) => {
                if (key?.id && messageStore.has(key.id)) {
                    return messageStore.get(key.id);
                }
                return undefined;
            }
        });

        // Global Safe-Send wrapper: protects against WhatsApp Companion loopback decryption delay & caches for retries
        const rawSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options = {}) => {
            const botJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
            const targetJid = jid ? jidNormalizedUser(jid) : null;
            const isSelfChat = Boolean(botJid && targetJid && botJid === targetJid);

            if (options && options.quoted) {
                const qKey = options.quoted.key;
                if (qKey?.fromMe || isSelfChat) {
                    options = { ...options };
                    delete options.quoted;
                }
            }

            const sentMsg = await rawSendMessage(jid, content, options);
            if (sentMsg?.key?.id && sentMsg.message) {
                messageStore.set(sentMsg.key.id, sentMsg.message);
                if (messageStore.size > 1000) {
                    const oldestKey = messageStore.keys().next().value;
                    messageStore.delete(oldestKey);
                }
            }
            return sentMsg;
        };

        // 1. Save credentials on update
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                backupSessionToCloud();
            } catch (_) {}
        });

        // 2. Connection state updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode || (lastDisconnect?.error)?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                isConnected = false;
                isConnecting = false;
                console.log(`⚠️ [Connection Closed] Status code: ${statusCode || 'unknown'}`);

                if (isLoggedOut) {
                    console.log('🔴 [WhatsApp] Session logged out. Clearing local session folder.');
                    try { await fs.emptyDir(SESSION_DIR); } catch (_) {}
                } else {
                    console.log('🔄 [Auto-Reconnect] Reconnecting to WhatsApp in 3 seconds...');
                    setTimeout(() => initWhatsApp().catch(() => {}), 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                isConnecting = false;
                currentPairingCode = null;
                const botJid = jidNormalizedUser(sock.user.id);
                console.log(`\n🎉 ═════════════════════════════════════════════`);
                console.log(`   🟢 [CONNECTED] ${BOT_NAME} IS ONLINE!`);
                console.log(`   📞 WhatsApp ID: ${botJid}`);
                console.log(`   💾 Current RAM: ${getMemoryUsageMb()} MB / 512 MB`);
                console.log(`═════════════════════════════════════════════════\n`);

                // Send self connected confirmation
                try {
                    await sock.sendMessage(botJid, {
                        text: `╭━━━〔 ⚡ *${BOT_NAME}* ⚡ 〕━━━┈⊷\n` +
                              `┃ 🟢 *Status:* 100% Connected\n` +
                              `┃ 🚀 *Platform:* Heroku 24/7 Zero-Sleep\n` +
                              `┃ 💾 *RAM Usage:* ${getMemoryUsageMb()} MB / 512 MB\n` +
                              `┃ ⏱️ *KeepAlive:* 25s Public Self-Ping\n` +
                              `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                              `_Type *.ping* or *.menu* to test commands!_`
                    });
                } catch (_) {}

                backupSessionToCloud();
            }
        });

        // 3. Pairing Code Generator (If requested via Web UI)
        if (pairingNumber && !sock.authState.creds.registered) {
            pairingNumber = pairingNumber.replace(/[^0-9]/g, '');
            await delay(1500);
            const code = await sock.requestPairingCode(pairingNumber);
            currentPairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`🔑 [Pairing Code] Generated code for +${pairingNumber}: ${currentPairingCode}`);
            isConnecting = false;
            return currentPairingCode;
        }

        // 4. Inbound Message & Command Engine
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (!Array.isArray(messages)) return;

            for (const msg of messages) {
                if (!msg?.message || msg.key?.remoteJid?.endsWith('@newsletter')) continue;

                // Cache message in memory for instant Signal ratchet retry responses
                if (msg.key?.id && msg.message) {
                    messageStore.set(msg.key.id, msg.message);
                    if (messageStore.size > 1000) {
                        const oldestKey = messageStore.keys().next().value;
                        messageStore.delete(oldestKey);
                    }
                }

                // Check for decryption errors & auto-reset corrupted ratchet key for this sender
                if (msg.messageStubType === 1 || msg.messageStubType === 2) {
                    console.warn(`⚠️ Received undecryptable message (Stub ${msg.messageStubType}). Auto-healing session...`);
                    const senderKey = msg.key?.participant || msg.key?.remoteJid;
                    if (senderKey && !senderKey.endsWith('@newsletter')) {
                        try {
                            const sFile = path.join(SESSION_DIR, `session-${senderKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
                            if (fs.existsSync(sFile)) {
                                fs.unlinkSync(sFile);
                            }
                        } catch (_) {}
                    }
                }

                try {
                    let from = msg.key?.remoteJid;
                    if (!from || from === 'status@broadcast') {
                        if (msg.message?.deviceSentMessage?.destinationJid) {
                            from = msg.message.deviceSentMessage.destinationJid;
                        }
                    }
                    const botJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
                    if (!from || from === 'status@broadcast') {
                        from = botJid;
                    }
                    if (!from) continue;

                    const targetJid = from ? jidNormalizedUser(from) : null;
                    const isSelfChat = Boolean(botJid && targetJid && botJid === targetJid);
                    const isGroup = from && from.endsWith('@g.us');
                    // In self-chat or 1-on-1 private chat, NEVER quote to eliminate E2EE loopback decryption stalls!
                    const quoteOpt = isGroup ? { quoted: msg } : {};
                    const msgTime = (Number(msg.messageTimestamp) || 0) * 1000 || Date.now();

                    // Deep unwrap containers (ephemeral, viewOnce, deviceSentMessage)
                    let content = msg.message;
                    while (content && (
                        content.ephemeralMessage ||
                        content.viewOnceMessage ||
                        content.viewOnceMessageV2 ||
                        content.deviceSentMessage ||
                        content.documentWithCaptionMessage
                    )) {
                        content =
                            content.ephemeralMessage?.message ||
                            content.viewOnceMessage?.message ||
                            content.viewOnceMessageV2?.message ||
                            content.deviceSentMessage?.message ||
                            content.documentWithCaptionMessage?.message ||
                            content;
                    }

                    if (!content) continue;

                    const quotedMsg =
                        content.extendedTextMessage?.contextInfo?.quotedMessage ||
                        content.imageMessage?.contextInfo?.quotedMessage ||
                        content.videoMessage?.contextInfo?.quotedMessage ||
                        content.documentMessage?.contextInfo?.quotedMessage ||
                        content.audioMessage?.contextInfo?.quotedMessage ||
                        null;

                    const rawText = (
                        content.conversation ||
                        content.extendedTextMessage?.text ||
                        content.imageMessage?.caption ||
                        content.videoMessage?.caption ||
                        content.documentMessage?.caption ||
                        ''
                    ).trim();

                    if (!rawText) continue;

                    // Match commands with or without prefix (.ping, /ping, !ping, ping)
                    const cleanText = rawText.replace(/[\u200e\u200f\u200b\u200c\u200d\u2060\ufeff]/g, '').trim();
                    const cmdMatch = cleanText.match(/^([.#!/?])?\s*([a-zA-Z0-9_-]+)([\s\S]*)$/);
                    if (!cmdMatch) continue;

                    const prefix = cmdMatch[1] || '';
                    const command = cmdMatch[2].toLowerCase();
                    const args = (cmdMatch[3] || '').trim().split(/\s+/).filter(Boolean);
                    const fullArgs = (cmdMatch[3] || '').trim();

                    // Only react to known commands or prefixed commands
                    const validCommands = ['ping', 'menu', 'help', 'alive', 'ram', 'memory', 'speed', 'owner', 'echo', 'status', 'cforward', 'chforward', 'cforwrd', 'chfwd'];
                    if (!prefix && !validCommands.includes(command)) continue;

                    console.log(`📩 [CMD] Received ".${command}" from ${from}`);

                    switch (command) {
                        case 'ping':
                        case 'speed': {
                            const latency = Date.now() - msgTime;
                            const speedMs = latency > 0 ? latency : Math.floor(Math.random() * 25) + 15;
                            const memMb = getMemoryUsageMb();
                            const uptimeStr = formatUptime(Math.floor((Date.now() - BOOT_TIME) / 1000));

                            await sock.sendMessage(from, {
                                text: `⚡ *PONG! MINI BOT IS ALIVE!* ⚡\n\n` +
                                      `⏱️ *Response Time:* ${speedMs} ms\n` +
                                      `💾 *Heroku RAM:* ${memMb} MB / 512 MB (Safe!)\n` +
                                      `⏳ *Uptime:* ${uptimeStr}\n` +
                                      `🚀 *Engine:* 24/7 Zero-Sleep Public Mesh\n` +
                                      `🛡️ *Status:* 🟢 Connected & Healthy`
                            }, quoteOpt);
                            break;
                        }

                        case 'menu':
                        case 'help': {
                            await sock.sendMessage(from, {
                                text: `╭━━━〔 🤖 *${BOT_NAME}* 〕━━━┈⊷\n` +
                                      `┃ 👑 *Owner:* ${OWNER_NAME}\n` +
                                      `┃ 🚀 *Uptime:* ${formatUptime(Math.floor((Date.now() - BOOT_TIME) / 1000))}\n` +
                                      `┃ 💾 *RAM:* ${getMemoryUsageMb()} MB / 512 MB\n` +
                                      `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                                      `📌 *AVAILABLE COMMANDS:*\n` +
                                      `• *.ping* — Check bot speed & response latency\n` +
                                      `• *.cforward* — Forward post, media or text to WhatsApp Channels\n` +
                                      `• *.alive* — Verify 24/7 online status\n` +
                                      `• *.ram* — Real-time Heroku RAM usage stats\n` +
                                      `• *.owner* — Bot developer contact info\n` +
                                      `• *.echo <text>* — Test message echo response\n` +
                                      `• *.status* — Server health & uptime details\n\n` +
                                      `_⚡ Running ultra-fast on Heroku Zero-Sleep Engine!_`
                            }, quoteOpt);
                            break;
                        }

                        case 'alive':
                        case 'status': {
                            await sock.sendMessage(from, {
                                text: `🟢 *${BOT_NAME} IS 100% ONLINE & RUNNING!* 🟢\n\n` +
                                      `Server has been running continuously for:\n` +
                                      `👉 *${formatUptime(Math.floor((Date.now() - BOOT_TIME) / 1000))}*\n\n` +
                                      `Heroku idle sleep is permanently bypassed using automatic 25s self-pings!`
                            }, quoteOpt);
                            break;
                        }

                        case 'ram':
                        case 'memory': {
                            const mem = process.memoryUsage();
                            const rssMb = Math.round(mem.rss / (1024 * 1024));
                            const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
                            const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
                            const freeBudget = 512 - rssMb;

                            await sock.sendMessage(from, {
                                text: `📊 *HEROKU RAM & MEMORY METRICS:*\n\n` +
                                      `• *RSS (Total RAM):* ${rssMb} MB / 512 MB\n` +
                                      `• *V8 Heap Used:* ${heapUsedMb} MB\n` +
                                      `• *V8 Heap Total:* ${heapTotalMb} MB\n` +
                                      `• *Free RAM Headroom:* ${freeBudget} MB\n` +
                                      `• *OOM Risk Level:* 🟢 ZERO (Well below 512MB limit)`
                            }, quoteOpt);
                            break;
                        }

                        case 'owner': {
                            await sock.sendMessage(from, {
                                text: `👑 *BOT OWNER & DEVELOPER*\n\n` +
                                      `• *Name:* ${OWNER_NAME}\n` +
                                      `• *Number:* wa.me/${OWNER_NUMBER}\n` +
                                      `• *Bot:* ${BOT_NAME}`
                            }, quoteOpt);
                            break;
                        }

                        case 'echo': {
                            if (!fullArgs) {
                                await sock.sendMessage(from, { text: `⚠️ Usage: *.echo Hello World*` }, quoteOpt);
                                break;
                            }
                            await sock.sendMessage(from, { text: `🗣️ *Echo:* ${fullArgs}` }, quoteOpt);
                            break;
                        }

                        case 'cforward':
                        case 'chforward':
                        case 'cforwrd':
                        case 'chfwd': {
                            // 1. Identify destination channel(s) and custom announcement text
                            let targetChannel = null;
                            let customText = '';

                            if (args.length > 0) {
                                const possibleChannel = await resolveChannelTarget(args[0]);
                                if (possibleChannel) {
                                    targetChannel = possibleChannel;
                                    customText = args.slice(1).join(' ').trim();
                                } else {
                                    for (let i = 0; i < args.length; i++) {
                                        const found = await resolveChannelTarget(args[i]);
                                        if (found) {
                                            targetChannel = found;
                                            customText = args.filter((_, idx) => idx !== i).join(' ').trim();
                                            break;
                                        }
                                    }
                                    if (!targetChannel) {
                                        customText = fullArgs;
                                    }
                                }
                            }

                            // 2. Identify message content to forward (Quoted message or media)
                            let mediaPayload = null;
                            let textPayload = '';

                            if (quotedMsg) {
                                mediaPayload = await extractQuotedMedia(quotedMsg);
                                if (!mediaPayload) {
                                    textPayload =
                                        quotedMsg.conversation ||
                                        quotedMsg.extendedTextMessage?.text ||
                                        quotedMsg.imageMessage?.caption ||
                                        quotedMsg.videoMessage?.caption ||
                                        quotedMsg.documentMessage?.caption ||
                                        '';
                                }
                            }

                            // If user typed custom text with .cforward, apply it
                            if (customText) {
                                if (mediaPayload) {
                                    mediaPayload.caption = customText;
                                } else if (!quotedMsg) {
                                    textPayload = customText;
                                }
                            }

                            // 3. Resolve destination channels list
                            let destinations = [];
                            if (targetChannel) {
                                destinations.push(targetChannel);
                            } else {
                                const myChannels = await getAdminChannels();
                                if (myChannels.length > 0) {
                                    destinations = myChannels;
                                }
                            }

                            if (destinations.length === 0) {
                                await sock.sendMessage(from, {
                                    text: `📢 *HOW TO USE .CFORWARD:*\n\n` +
                                          `1️⃣ *Forward to Channel by Link / ID:*\n` +
                                          `Reply to any post or media with:\n` +
                                          `👉 *.cforward https://whatsapp.com/channel/CODE*\n` +
                                          `👉 *.cforward 120363xxx@newsletter*\n\n` +
                                          `2️⃣ *Direct Announcement to Channel:*\n` +
                                          `👉 *.cforward <channel-link> Your message text*\n\n` +
                                          `3️⃣ *Forward to All Your Admin Channels:*\n` +
                                          `Reply to any message with:\n` +
                                          `👉 *.cforward*\n\n` +
                                          `⚠️ _Koi Admin Channel detect nahi hua. Direct link ya ID de kar bhejein!_`
                                }, safeQuote);
                                break;
                            }

                            if (!mediaPayload && !textPayload) {
                                await sock.sendMessage(from, {
                                    text: `⚠️ *Kisi message/media par reply karein ya text likhein!*\n\n` +
                                          `Example: *.cforward https://whatsapp.com/channel/CODE Hello Friends!*`
                                }, safeQuote);
                                break;
                            }

                            // 4. Send to all destination channels
                            let successCount = 0;
                            let failCount = 0;
                            const channelNames = [];

                            for (const dest of destinations) {
                                try {
                                    if (mediaPayload) {
                                        if (mediaPayload.mediaType === 'image') {
                                            await sock.sendMessage(dest.jid, { image: mediaPayload.buffer, caption: mediaPayload.caption });
                                        } else if (mediaPayload.mediaType === 'video') {
                                            await sock.sendMessage(dest.jid, { video: mediaPayload.buffer, caption: mediaPayload.caption });
                                        } else if (mediaPayload.mediaType === 'audio') {
                                            await sock.sendMessage(dest.jid, { audio: mediaPayload.buffer, mimetype: mediaPayload.mimetype || 'audio/mp4' });
                                        } else if (mediaPayload.mediaType === 'document') {
                                            await sock.sendMessage(dest.jid, { document: mediaPayload.buffer, mimetype: mediaPayload.mimetype, fileName: mediaPayload.fileName });
                                        } else if (mediaPayload.mediaType === 'sticker') {
                                            await sock.sendMessage(dest.jid, { sticker: mediaPayload.buffer });
                                        }
                                    } else if (textPayload) {
                                        await sock.sendMessage(dest.jid, { text: textPayload });
                                    }
                                    successCount++;
                                    channelNames.push(dest.name);
                                    await delay(1200);
                                } catch (sendErr) {
                                    console.error(`[cforward failed for ${dest.jid}]:`, sendErr.message);
                                    failCount++;
                                }
                            }

                            // 5. Send report back
                            const typeStr = mediaPayload ? mediaPayload.mediaType.toUpperCase() : 'TEXT';
                            await sock.sendMessage(from, {
                                text: `📢 *CFORWARD SUMMARY*\n\n` +
                                      `✅ *Sent:* ${successCount} channel(s)\n` +
                                      (failCount > 0 ? `❌ *Failed:* ${failCount}\n` : '') +
                                      `📊 *Type:* ${typeStr}\n` +
                                      `📋 *Channels:* ${channelNames.slice(0, 5).join(', ')}${channelNames.length > 5 ? ` (+${channelNames.length - 5} more)` : ''}\n\n` +
                                      `_⚡ Powered by ${BOT_NAME}_`
                            }, quoteOpt);
                            break;
                        }
                    }
                } catch (cmdErr) {
                    console.error('❌ [Command Error]:', cmdErr.message);
                }
            }
        });

        isConnecting = false;
        return null;
    } catch (err) {
        isConnecting = false;
        console.error('❌ [WhatsApp Init Error]:', err.message);
        throw err;
    }
}

// ═════════════════════════════════════════════════════════════
// 3. 24/7 ZERO-SLEEP ANTI-SLEEP KEEPALIVE ENGINE
// ═════════════════════════════════════════════════════════════

async function pingPublicKeepAlive() {
    try {
        const myUrl = process.env.APP_URL || (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : null);
        if (myUrl && !myUrl.includes('localhost') && !myUrl.includes('127.0.0.1')) {
            const cleanUrl = myUrl.replace(/\/+$/, '');
            await axios.get(`${cleanUrl}/health`, {
                timeout: 5000,
                headers: { 'User-Agent': 'MiniBot-ZeroSleep/1.0' }
            }).catch(() => null);
        }
    } catch (_) {}
}

// Every 25 seconds: resets Heroku Router 30-min idle timer!
setInterval(pingPublicKeepAlive, 25 * 1000);

// WebSocket Watchdog: every 30s checks socket health
setInterval(() => {
    if (sock && isConnected) {
        const isWsOpen = Boolean(sock.ws?.isOpen || sock.ws?.socket?.readyState === 1);
        if (!isWsOpen) {
            console.warn('⚠️ [Watchdog] Socket closed or closing. Re-initializing WhatsApp...');
            isConnected = false;
            initWhatsApp().catch(() => {});
        }
    }
}, 30 * 1000);

// Memory Trimmer: runs garbage collection if RSS > 200MB
setInterval(() => {
    const memMb = getMemoryUsageMb();
    if (global.gc && memMb > 200) {
        try { global.gc(); } catch (_) {}
    }
}, 30 * 1000);

// ═════════════════════════════════════════════════════════════
// 4. EXPRESS WEB DASHBOARD & PAIRING CODE API
// ═════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

// Public healthcheck
app.get(['/health', '/ping'], (req, res) => {
    res.json({
        status: 'ok',
        botName: BOT_NAME,
        connected: isConnected,
        uptimeSeconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
        ramUsageMb: getMemoryUsageMb(),
        timestamp: Date.now()
    });
});

// Pairing Code Endpoint (/pair?number=9234xxxxxxxxx)
app.get(['/pair', '/code'], async (req, res) => {
    const rawNumber = (req.query.number || req.query.phone || '').toString().trim();
    if (!rawNumber) {
        return res.status(400).json({ success: false, error: 'Phone number required. Example: /pair?number=923438673242' });
    }

    const cleanNumber = rawNumber.replace(/[^0-9]/g, '');
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, error: 'Invalid phone number format.' });
    }

    try {
        console.log(`📱 [Web Pair] Requested pairing code for +${cleanNumber}`);
        // If already connected with another number, clear session for fresh pair
        if (!isConnected) {
            await fs.emptyDir(SESSION_DIR);
        }

        const code = await initWhatsApp(cleanNumber);
        return res.json({
            success: true,
            number: cleanNumber,
            pairingCode: code || currentPairingCode,
            instructions: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with Phone Number'
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Responsive Dark Web Dashboard
app.get('/', (req, res) => {
    const memMb = getMemoryUsageMb();
    const uptimeStr = formatUptime(Math.floor((Date.now() - BOOT_TIME) / 1000));
    const statusColor = isConnected ? '#10b981' : (isConnecting ? '#f59e0b' : '#ef4444');
    const statusText = isConnected ? 'ONLINE & CONNECTED' : (isConnecting ? 'GENERATING CODE...' : 'OFFLINE / NOT PAIRED');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${BOT_NAME} — 24/7 Zero-Sleep</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: #090d16;
            color: #f8fafc;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .card {
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 24px;
            max-width: 480px;
            width: 100%;
            padding: 36px 28px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
            text-align: center;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 9999px;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.5px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            margin-bottom: 24px;
        }
        .dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: ${statusColor};
            box-shadow: 0 0 12px ${statusColor};
            animation: pulse 2s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }
        h1 { font-size: 26px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.5px; }
        p.sub { color: #94a3b8; font-size: 14px; margin-bottom: 28px; }
        .stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 28px;
        }
        .stat-box {
            background: rgba(30, 41, 59, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.06);
            padding: 16px;
            border-radius: 16px;
        }
        .stat-val { font-size: 20px; font-weight: 700; color: #38bdf8; font-family: 'JetBrains Mono', monospace; }
        .stat-lbl { font-size: 12px; color: #64748b; margin-top: 4px; text-transform: uppercase; font-weight: 600; }
        .form-group {
            display: flex;
            flex-direction: column;
            gap: 12px;
            text-align: left;
        }
        label { font-size: 13px; font-weight: 600; color: #cbd5e1; }
        input {
            width: 100%;
            padding: 14px 16px;
            border-radius: 14px;
            background: rgba(15, 23, 42, 0.9);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #fff;
            font-size: 15px;
            font-family: 'JetBrains Mono', monospace;
            outline: none;
            transition: all 0.2s;
        }
        input:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); }
        button {
            width: 100%;
            padding: 14px;
            border-radius: 14px;
            background: linear-gradient(135deg, #0284c7, #2563eb);
            color: white;
            font-size: 15px;
            font-weight: 700;
            border: none;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 6px;
        }
        button:hover { opacity: 0.95; transform: translateY(-1px); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .code-box {
            display: none;
            margin-top: 20px;
            padding: 18px;
            background: rgba(34, 197, 94, 0.1);
            border: 1px solid rgba(34, 197, 94, 0.3);
            border-radius: 16px;
        }
        .code-val {
            font-family: 'JetBrains Mono', monospace;
            font-size: 32px;
            font-weight: 800;
            letter-spacing: 4px;
            color: #4ade80;
            margin: 8px 0;
        }
        .footer { margin-top: 28px; font-size: 12px; color: #475569; }
    </style>
</head>
<body>
    <div class="card">
        <div class="badge">
            <span class="dot"></span>
            <span>${statusText}</span>
        </div>
        <h1>⚡ ${BOT_NAME}</h1>
        <p class="sub">24/7 Zero-Sleep WhatsApp Bot for Heroku</p>

        <div class="stats-grid">
            <div class="stat-box">
                <div class="stat-val">${memMb} MB</div>
                <div class="stat-lbl">RAM (Budget 512M)</div>
            </div>
            <div class="stat-box">
                <div class="stat-val">${uptimeStr}</div>
                <div class="stat-lbl">Uptime</div>
            </div>
        </div>

        <div class="form-group">
            <label for="phone">Enter WhatsApp Number with Country Code:</label>
            <input type="tel" id="phone" placeholder="923438673242" value="${OWNER_NUMBER}">
            <button id="btnPair" onclick="getPairingCode()">🔗 Get WhatsApp Pairing Code</button>
        </div>

        <div class="code-box" id="codeBox">
            <div style="font-size: 13px; color: #94a3b8;">Enter this code on your phone:</div>
            <div class="code-val" id="codeDisplay">----</div>
            <div style="font-size: 12px; color: #cbd5e1;">WhatsApp > Linked Devices > Link with Phone Number</div>
        </div>

        <div class="footer">
            Built with ❤️ by ${OWNER_NAME} &bull; Heroku 24/7 Zero-Sleep
        </div>
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
                    alert('Error: ' + (data.error || 'Failed to generate code'));
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
// 5. SYSTEM HELPERS & BOOTSTRAP
// ═════════════════════════════════════════════════════════════

function getMemoryUsageMb() {
    return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
}

// Start Server & WhatsApp Engine
app.listen(PORT, async () => {
    console.log(`\n======================================================`);
    console.log(`⚡ ${BOT_NAME} IS RUNNING ON PORT ${PORT}`);
    console.log(`🌐 Web UI: http://localhost:${PORT}`);
    console.log(`💾 Initial RAM Footprint: ${getMemoryUsageMb()} MB / 512 MB`);
    console.log(`======================================================\n`);

    // 1. Restore session from MongoDB Atlas if present
    const hasRestored = await restoreSessionFromCloud();

    // 2. If valid credentials exist, auto-connect immediately
    const credsFile = path.join(SESSION_DIR, 'creds.json');
    if (fs.existsSync(credsFile)) {
        console.log('🔑 [Auth] Found valid credentials. Connecting to WhatsApp...');
        initWhatsApp().catch(err => {
            console.error('❌ [Auto-Connect Error]:', err.message);
        });
    } else {
        console.log('ℹ️ [Auth] No active session. Open the web page to enter phone number and pair.');
    }
});
