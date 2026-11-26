'use strict';

/**
 * SIGMA MD :: WhatsApp Channel (@newsletter) Command Suite (16 commands)
 * Protected by strict Owner checks on mutating / channel-posting commands.
 */

const crypto = require('crypto');
const configStore = require('../configStore');
const {
    resolveChannelTarget,
    getSubscribedChannels,
    extractMedia,
    unwrapMessage,
    getContextInfo,
    getTextFromContent,
    httpClient,
    sleep,
    withTimeout
} = require('../mediaHelper');

const CLUSTER_SECRET = process.env.CLUSTER_SECRET || 'saqib_cluster_secure_mesh_2026';
const CLUSTER_URLS = [
    'https://saqib-bot-v1-d3ecc6f0292e.herokuapp.com', 'https://saqib-bot-s2-1cceb03e9698.herokuapp.com',
    'https://saqibbot3-bb2b46aa1cb4.herokuapp.com', 'https://saqibot4-1469f73b3d77.herokuapp.com',
    'https://saqibbot5-5ffa090fe31f.herokuapp.com', 'https://saqibot6-061b6d17645d.herokuapp.com',
    'https://saqibot7-b9d00e67a587.herokuapp.com', 'https://saqibbot8-f10fafc8b934.herokuapp.com',
    'https://saqibbot9-bebb531508e3.herokuapp.com', 'https://saqibot10-d27e9f3ad01e.herokuapp.com',
    'https://saqibbot11-815563078799.herokuapp.com', 'https://saqibbot12-2fb338ff529a.herokuapp.com',
    'https://saqibot13-392b066b37a5.herokuapp.com', 'https://saqibbot14-d84e8d59500a.herokuapp.com',
    'https://saqibbot16-b071c813d801.herokuapp.com', 'https://saqibot17-a471970ef223.herokuapp.com',
    'https://saqibbot18-45854000f60b.herokuapp.com', 'https://saqibbot19-bb306a89a5f4.herokuapp.com',
    'https://saqibbot20-317bb68e4db0.herokuapp.com', 'https://saqibbot21-ac7859f5f0fb.herokuapp.com',
    'https://saqibot21-0b44cf00a75a.herokuapp.com', 'https://saqibbot22-9318c2de0250.herokuapp.com',
    'https://saqibot23-1f4bec48d0f2.herokuapp.com', 'https://saqibbot25-46c4cf949a77.herokuapp.com',
    'https://saqibot25-0974df36edd8.herokuapp.com', 'https://saqibot26-69a8011cc819.herokuapp.com',
    'https://saqibot27-1c1d295781fa.herokuapp.com', 'https://saqibbot28-658e7de676c8.herokuapp.com',
    'https://saqibot29-94eae3596692.herokuapp.com', 'https://saqibot30-e89854c3fef2.herokuapp.com',
    'https://saqibot32-daa98fd51f65.herokuapp.com', 'https://saqibot33-454998cdc49b.herokuapp.com',
    'https://saqibot34-88b9afd45ae5.herokuapp.com', 'https://saqibot35-b5a65594dc78.herokuapp.com',
    'https://saqibot36-822da6a7cddd.herokuapp.com', 'https://saqibot37-46d3819a472c.herokuapp.com',
    'https://saqibot38-520caade1fd3.herokuapp.com', 'https://saqibot39-6fa296b89e98.herokuapp.com',
    'https://saqibot40-d19a79bf6170.herokuapp.com', 'https://saqibbot41-fd5991fd6038.herokuapp.com',
    'https://saqibbot42-18e1d04afef3.herokuapp.com', 'https://saqibot43-4ac9ae252f6b.herokuapp.com',
    'https://saqibobot44-6379b396e027.herokuapp.com', 'https://saqibot45-4fee2ad8369c.herokuapp.com',
    'https://saqibbt46-3c399938d5a6.herokuapp.com', 'https://saqibot47-6f2e03e874fc.herokuapp.com',
    'https://saqibot48-ac004fb8d44b.herokuapp.com', 'https://saqibot49-e792da7c6864.herokuapp.com',
    'https://saqibot50-d29d71852e9a.herokuapp.com', 'https://web-production-08da5300.up.railway.app'
];

async function broadcastToMiniCluster(action, payload) {
    await Promise.allSettled(CLUSTER_URLS.map((baseUrl) =>
        httpClient.post(`${baseUrl}/api/cluster-action`, {
            action,
            fromNode: 'sigmamini',
            secret: CLUSTER_SECRET,
            payload,
            timestamp: Date.now()
        }, {
            timeout: 8000,
            headers: { 'x-cluster-secret': CLUSTER_SECRET, 'Content-Type': 'application/json' }
        }).catch(() => null)
    ));
}

async function resolveFromMiniCluster(action, payload, isValid) {
    return new Promise((resolve) => {
        let pending = CLUSTER_URLS.length;
        let done = false;
        for (const baseUrl of CLUSTER_URLS) {
            httpClient.post(`${baseUrl}/api/cluster-action`, {
                action,
                fromNode: 'sigmamini',
                secret: CLUSTER_SECRET,
                payload,
                timestamp: Date.now()
            }, {
                timeout: 4500,
                headers: { 'x-cluster-secret': CLUSTER_SECRET, 'Content-Type': 'application/json' }
            }).then((res) => {
                if (!done && isValid(res?.data)) {
                    done = true;
                    resolve(res.data);
                }
            }).catch(() => {}).finally(() => {
                pending--;
                if (pending === 0 && !done) resolve(null);
            });
        }
    });
}

function parseMiniChannelInput(args = [], msg = null, defaultToken = '❤️') {
    let rawText = (args || []).join(' ').trim();
    let code = null;
    let jid = null;
    let postId = null;
    let name = 'WhatsApp Channel';

    const urlMatch = rawText.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{8,})(?:\/([0-9]+))?(?:\?[^\s]*)?/i);
    if (urlMatch) {
        code = urlMatch[1];
        if (urlMatch[2]) postId = urlMatch[2];
        rawText = rawText.replace(urlMatch[0], '').trim();
    }
    if (!code) {
        const jidMatch = rawText.match(/([0-9]{10,}@newsletter)(?:[\s/]+([0-9]+))?/i);
        if (jidMatch) {
            jid = jidMatch[1];
            if (jidMatch[2]) postId = jidMatch[2];
            rawText = rawText.replace(jidMatch[0], '').trim();
        }
    }
    const unwrapped = unwrapMessage(msg?.message);
    const ctx = getContextInfo(unwrapped);
    const qUnwrapped = unwrapMessage(ctx?.quotedMessage);
    const fnmi = ctx?.forwardedNewsletterMessageInfo || getContextInfo(qUnwrapped)?.forwardedNewsletterMessageInfo;
    if (fnmi?.newsletterJid) {
        if (!jid && !code) jid = fnmi.newsletterJid;
        if (!postId && (fnmi.serverMessageId ?? fnmi.newsletterServerMessageId)) {
            postId = String(fnmi.serverMessageId ?? fnmi.newsletterServerMessageId);
        }
        if (fnmi.newsletterName) name = fnmi.newsletterName;
    }
    if ((!code && !jid) || !postId) {
        const quotedText = qUnwrapped?.conversation ||
            qUnwrapped?.extendedTextMessage?.text ||
            qUnwrapped?.extendedTextMessage?.canonicalUrl ||
            qUnwrapped?.extendedTextMessage?.matchedText ||
            qUnwrapped?.imageMessage?.caption ||
            qUnwrapped?.videoMessage?.caption ||
            qUnwrapped?.documentMessage?.caption || '';
        if (quotedText) {
            const qUrlMatch = quotedText.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{8,})(?:\/([0-9]+))?/i);
            if (qUrlMatch) {
                if (!code && !jid) code = qUrlMatch[1];
                if (!postId && qUrlMatch[2]) postId = qUrlMatch[2];
            } else {
                const qJidMatch = quotedText.match(/([0-9]{10,}@newsletter)(?:[\s/]+([0-9]+))?/i);
                if (qJidMatch) {
                    if (!code && !jid) jid = qJidMatch[1];
                    if (!postId && qJidMatch[2]) postId = qJidMatch[2];
                }
            }
        }
    }
    if (!postId && rawText) {
        const allNums = rawText.match(/\b([0-9]{1,10})\b/g);
        if (allNums && allNums.length > 0) {
            const picked = allNums.length > 1
                ? (allNums.find(n => Number(n) > 12) || allNums[allNums.length - 1])
                : allNums[0];
            postId = picked;
            rawText = rawText.replace(new RegExp(`\\b${picked}\\b`), '').trim();
        }
    }
    return { code, jid, postId, name, extraText: rawText || defaultToken };
}

function extractPollOptsFromObj(m, depth = 0) {
    if (!m || typeof m !== 'object' || depth > 4) return null;
    const cands = [
        m.pollCreationMessage, m.pollCreationMessageV2, m.pollCreationMessageV3, m.pollCreationMessageV5,
        m.pollCreationMessageV4?.message?.pollCreationMessage, m.pollCreationMessageV4?.message?.pollCreationMessageV3,
        m.pollResultSnapshotMessage, m.pollResultSnapshotMessageV3,
        m.pollCreationMessageV4?.message?.pollResultSnapshotMessage
    ];
    for (const c of cands) {
        const raw = c?.options || c?.pollVotes;
        if (Array.isArray(raw) && raw.length > 0) {
            const opts = raw.map(o => typeof o === 'string' ? o : (o?.optionName || '')).filter(Boolean);
            if (opts.length > 0) return { name: c.name || 'Channel Poll', options: opts };
        }
    }
    for (const w of [m.ephemeralMessage?.message, m.viewOnceMessage?.message, m.viewOnceMessageV2?.message, m.message]) {
        if (w && w !== m) {
            const r = extractPollOptsFromObj(w, depth + 1);
            if (r) return r;
        }
    }
    return null;
}

async function handleMiniChvote(ctx, fixedOpt = null) {
    if (!ctx.isOwner) return denyChannelOwner(ctx);
    const argsStr = (ctx.args || []).join(' ');
    const hasExplicitTargetInArgs = /(?:whatsapp\.com\/channel\/|[0-9]{10,}@newsletter)/i.test(argsStr);
    const parsed = parseMiniChannelInput(ctx.args, ctx.msg, fixedOpt || '1');

    // Preserve `.vote Question | Opt1 | Opt2` poll creation ONLY when pipe-syntax is explicitly used without channel/poll targets
    if (ctx.commandName === 'vote' && !parsed.code && !parsed.jid && !parsed.postId && !ctx.quotedMsg && (ctx.fullArgs || '').includes('|')) {
        const pipeParts = String(ctx.fullArgs || '').split('|').map(s => s.trim()).filter(Boolean);
        if (pipeParts.length >= 3) {
            return await ctx.sock.sendMessage(ctx.from, {
                poll: { name: pipeParts[0], values: pipeParts.slice(1, 13), selectableCount: 1 }
            });
        }
    }

    const qPoll = (!hasExplicitTargetInArgs && ctx.quotedMsg) ? extractPollOptsFromObj(ctx.quotedMsg) : null;
    const lookupToken = parsed.code
        ? `https://whatsapp.com/channel/${parsed.code}${parsed.postId ? '/' + parsed.postId : ''}`
        : (parsed.jid || ctx.args[0] || '');

    let info = await resolveChannelTarget(ctx.sock, lookupToken, hasExplicitTargetInArgs ? null : ctx.msg).catch(() => null);
    let jid = info?.jid || parsed.jid;
    let code = info?.inviteCode || parsed.code;
    const serverId = parsed.postId || info?.postId;
    const chName = info?.name || parsed.name;

    if (!jid && code) {
        const cRes = await resolveFromMiniCluster('resolve_channel', { code }, d => d?.jid && /^\d+@newsletter$/.test(d.jid));
        if (cRes?.jid) jid = cRes.jid;
    }

    // Quoted normal Group/DM Chat Poll voting fallback on .vote / .chvote
    if (((!jid && !code) || !serverId) && qPoll && Array.isArray(qPoll.options) && qPoll.options.length > 0) {
        const mCtx = getContextInfo(unwrapMessage(ctx.msg?.message));
        const qUnwrapped = unwrapMessage(ctx.quotedMsg);
        const secret = qUnwrapped?.messageContextInfo?.messageSecret || ctx.quotedMsg?.messageContextInfo?.messageSecret || ctx.content?.messageContextInfo?.messageSecret;
        if (secret && mCtx?.stanzaId) {
            const { proto, jidNormalizedUser } = require('@whiskeysockets/baileys');
            const { hmacSign, aesEncryptGCM } = require('@whiskeysockets/baileys/lib/Utils/crypto');
            const optChoiceRaw = fixedOpt || (ctx.fullArgs || '').trim() || '1';
            const cleanChoice = String(optChoiceRaw).trim();
            const lettersMap = { a: 0, b: 1, c: 2, d: 3, e: 4 };
            let chosenOpt = qPoll.options[0];
            if (/^\d+$/.test(cleanChoice)) {
                chosenOpt = qPoll.options[Math.max(0, Math.min(qPoll.options.length - 1, parseInt(cleanChoice, 10) - 1))];
            } else if (lettersMap[cleanChoice.toLowerCase()] !== undefined) {
                chosenOpt = qPoll.options[Math.max(0, Math.min(qPoll.options.length - 1, lettersMap[cleanChoice.toLowerCase()]))];
            } else {
                chosenOpt = qPoll.options.find(o => o.toLowerCase() === cleanChoice.toLowerCase() || o.toLowerCase().includes(cleanChoice.toLowerCase())) || qPoll.options[0];
            }
            const optHash = crypto.createHash('sha256').update(String(chosenOpt), 'utf8').digest();
            const pollCreatorJid = mCtx.participant ? jidNormalizedUser(mCtx.participant) : jidNormalizedUser(ctx.from);
            const voterJid = ctx.sock?.user?.id ? jidNormalizedUser(ctx.sock.user.id) : null;
            if (voterJid) {
                const encKeyBuf = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
                const sign = Buffer.concat([Buffer.from(mCtx.stanzaId), Buffer.from(pollCreatorJid), Buffer.from(voterJid), Buffer.from('Poll Vote'), new Uint8Array([1])]);
                const decKey = hmacSign(sign, hmacSign(encKeyBuf, new Uint8Array(32), 'sha256'), 'sha256');
                const encIv = crypto.randomBytes(12);
                const encPayload = aesEncryptGCM(proto.Message.PollVoteMessage.encode({ selectedOptions: [optHash] }).finish(), decKey, encIv, Buffer.from(mCtx.stanzaId + '\u0000' + voterJid));
                await ctx.sock.relayMessage(ctx.from, {
                    pollUpdateMessage: {
                        pollCreationMessageKey: {
                            remoteJid: ctx.from,
                            fromMe: false,
                            id: mCtx.stanzaId,
                            ...(ctx.isGroup ? { participant: pollCreatorJid } : {})
                        },
                        vote: { encPayload, encIv },
                        senderTimestampMs: Date.now()
                    }
                }, { additionalNodes: [{ tag: 'meta', attrs: { polltype: 'vote' } }] });
                ctx.react('✅');
                return ctx.reply(`✅ *Poll Vote Cast!* Option: *${chosenOpt}*`);
            }
        }
    }

    if ((!jid && !code) || !serverId) {
        return ctx.reply(
            `🗳️ *SIGMA MD — CHANNEL POLL VOTE*\n\n` +
            `📌 *Dono Commands & Tarike Working Hain:*\n` +
            `• *${ctx.prefix}chvote https://whatsapp.com/channel/CODE/123 1* ya *${ctx.prefix}vote <link> 1*\n` +
            `• *${ctx.prefix}vote 2 <link>* ya *${ctx.prefix}chvote 2 <link>*\n` +
            `• Ya channel poll post par reply karke *${ctx.prefix}vote1* / *${ctx.prefix}vote 2* / *${ctx.prefix}chvote 2* likhein!`
        );
    }

    ctx.react('⏳');
    const optChoice = fixedOpt || parsed.extraText || '1';
    let optionsList = qPoll?.options || [];

    if (optionsList.length === 0 && jid && /^\d+@newsletter$/.test(jid)) {
        const cPoll = await resolveFromMiniCluster('resolve_poll', { jid, serverId, code }, d => d?.ok && Array.isArray(d.options) && d.options.length > 0);
        if (cPoll?.options?.length) optionsList = cPoll.options;
    }

    const letters = { a: 0, b: 1, c: 2, d: 3, e: 4 };
    const cleanOpt = String(optChoice).trim();
    const lowerOpt = cleanOpt.toLowerCase();
    let selectedOptionName = null;
    if (optionsList.length > 0) {
        if (/^\d+$/.test(cleanOpt)) {
            selectedOptionName = optionsList[Math.max(0, Math.min(optionsList.length - 1, parseInt(cleanOpt, 10) - 1))];
        } else if (letters[lowerOpt] !== undefined) {
            selectedOptionName = optionsList[Math.max(0, Math.min(optionsList.length - 1, letters[lowerOpt]))];
        } else {
            selectedOptionName = optionsList.find(o => String(o).toLowerCase() === lowerOpt || String(o).toLowerCase().includes(lowerOpt)) || cleanOpt;
        }
    } else if (!/^\d+$/.test(cleanOpt) && letters[lowerOpt] === undefined) {
        selectedOptionName = cleanOpt;
    }

    if (!selectedOptionName) {
        return ctx.reply(`❌ Channel poll ki options fetch nahi ho sakin! Poll post ko forward kar ke reply mein *${ctx.prefix}chvote 1* likhein ya option ka exact naam dein (e.g. *${ctx.prefix}chvote <link> Yes*).`);
    }

    const optHash = crypto.createHash('sha256').update(String(selectedOptionName), 'utf8').digest();
    const optHashHex = optHash.toString('hex');

    broadcastToMiniCluster('chvote', {
        jid,
        code: code || null,
        serverId: String(serverId),
        optionIndexOrName: cleanOpt,
        selectedOptionName,
        optionsList,
        optHashHex,
        pollResolved: true,
        channelName: chName
    }).catch(() => {});

    if (jid && /^\d+@newsletter$/.test(jid) && typeof ctx.sock.query === 'function') {
        await ctx.sock.newsletterFollow?.(jid).catch(() => {});
        const msgId = typeof ctx.sock.generateMessageTag === 'function' ? ctx.sock.generateMessageTag() : `${Date.now()}`;
        await withTimeout(ctx.sock.query({
            tag: 'message',
            attrs: { to: jid, id: msgId, type: 'poll', server_id: String(serverId) },
            content: [
                { tag: 'meta', attrs: { polltype: 'vote' } },
                { tag: 'votes', attrs: {}, content: [{ tag: 'vote', attrs: {}, content: optHash }] }
            ]
        }, 4000), 4500, 'Channel poll vote').catch(() => {});
    }

    ctx.react('✅');
    return ctx.reply(
        `✅ *VOTES SENT ACROSS ALL ${CLUSTER_URLS.length} SERVERS!*\n\n` +
        `🎯 *Channel:* ${chName}\n` +
        `📝 *Post:* #${serverId}\n` +
        `🗳️ *Option:* ${selectedOptionName}\n` +
        `🖥️ *Cluster:* All ${CLUSTER_URLS.length} Servers + SIGMA MD`
    );
}

async function denyChannelOwner(ctx) {
    return await ctx.reply('🔒 Sirf *Bot Owner* Channel posting / management commands chala sakta hai!');
}

function splitPipeArgs(raw) {
    return String(raw || '').split('|').map((s) => s.trim()).filter(Boolean);
}

async function resolveChannelAndRest(ctx) {
    for (let i = 0; i < ctx.args.length; i++) {
        const found = await resolveChannelTarget(ctx.sock, ctx.args[i], ctx.msg).catch(() => null);
        if (found) {
            const rest = ctx.args.filter((_, idx) => idx !== i).join(' ').trim();
            return { channel: found, rest };
        }
    }
    const ctxFound = await resolveChannelTarget(ctx.sock, '', ctx.msg).catch(() => null);
    if (ctxFound) return { channel: ctxFound, rest: ctx.fullArgs };
    return { channel: null, rest: ctx.fullArgs };
}

async function sendPayloadToChannel(sock, jid, mediaPayload, textPayload) {
    if (mediaPayload) {
        if (mediaPayload.mediaType === 'image') {
            return sock.sendMessage(jid, { image: mediaPayload.buffer, caption: mediaPayload.caption });
        }
        if (mediaPayload.mediaType === 'video') {
            return sock.sendMessage(jid, { video: mediaPayload.buffer, caption: mediaPayload.caption });
        }
        if (mediaPayload.mediaType === 'audio') {
            return sock.sendMessage(jid, { audio: mediaPayload.buffer, mimetype: mediaPayload.mimetype || 'audio/mp4', ptt: mediaPayload.ptt });
        }
        if (mediaPayload.mediaType === 'document') {
            return sock.sendMessage(jid, { document: mediaPayload.buffer, mimetype: mediaPayload.mimetype || 'application/octet-stream', fileName: mediaPayload.fileName });
        }
        if (mediaPayload.mediaType === 'sticker') {
            return sock.sendMessage(jid, { sticker: mediaPayload.buffer });
        }
    }
    if (textPayload) {
        return sock.sendMessage(jid, { text: textPayload });
    }
}

const commands = [
    {
        name: 'cforward',
        aliases: ['chforward', 'cf', 'cforwrd', 'chfwd'],
        category: 'channel',
        desc: 'Quoted media/text ya naya text WhatsApp Channel par bhejein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const { channel, rest } = await resolveChannelAndRest(ctx);

            let mediaPayload = null;
            let textPayload = '';

            if (ctx.quotedMsg) {
                mediaPayload = await extractMedia(ctx.quotedMsg);
                if (!mediaPayload) {
                    textPayload = getTextFromContent(unwrapMessage(ctx.quotedMsg));
                }
            }

            // Custom text overrides quoted text cleanly (fixing old mini-bot bug!)
            if (rest) {
                if (mediaPayload) mediaPayload.caption = rest;
                else textPayload = rest;
            }

            let destinations = [];
            if (channel) {
                destinations.push(channel);
            } else {
                destinations = await getSubscribedChannels(ctx.sock, true);
            }

            if (!destinations.length) {
                return ctx.reply(
                    `📢 *USAGE: ${ctx.prefix}cforward*\n` +
                    `• Reply + *${ctx.prefix}cforward <channel-link>*\n` +
                    `• Direct: *${ctx.prefix}cforward <channel-link> Naya Message*\n` +
                    `• Admin Channels: Reply + *${ctx.prefix}cforward*`
                );
            }
            if (!mediaPayload && !textPayload) {
                return ctx.reply(`⚠️ Kisi post/media par reply karein ya text likhein!\nExample: *${ctx.prefix}cforward https://whatsapp.com/channel/CODE Hello!*`);
            }

            let ok = 0;
            let fail = 0;
            const sentNames = [];
            for (const dest of destinations) {
                try {
                    await sendPayloadToChannel(ctx.sock, dest.jid, mediaPayload, textPayload);
                    ok++;
                    sentNames.push(dest.name);
                    await sleep(1000);
                } catch (_) {
                    fail++;
                }
            }
            await ctx.reply(
                `📢 *CFORWARD SUMMARY*\n` +
                `✅ *Sent:* ${ok} channel(s)${fail ? `\n❌ *Failed:* ${fail}` : ''}\n` +
                `📋 *Targets:* ${sentNames.slice(0, 6).join(', ') || 'None'}`
            );
        }
    },
    {
        name: 'chpost',
        aliases: ['channelpost'],
        category: 'channel',
        desc: 'Direct channel par text ya quoted image post karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const cforward = commands.find((c) => c.name === 'cforward');
            return cforward.handler(ctx);
        }
    },
    {
        name: 'chinfo',
        aliases: ['channelid', 'chid', 'chjid', 'channeljid', 'chlink'],
        category: 'channel',
        desc: 'Channel link ya forwarded post se JID, Followers aur Info nikalein',
        handler: async (ctx) => {
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) {
                return ctx.reply(`Usage: *${ctx.prefix}chinfo <channel-link | @newsletter JID>* ya kisi forwarded channel post par reply karein.`);
            }
            await ctx.reply(
                `╭━━━〔 📢 *CHANNEL INFO* 〕━━━┈⊷\n` +
                `┃ 📛 *Name:* ${info.name}\n` +
                `┃ 🆔 *JID:* \`${info.jid}\`\n` +
                (info.postId ? `┃ 📌 *Post ID:* \`${info.postId}\`\n` : '') +
                (info.followers != null ? `┃ 👥 *Followers:* ${info.followers}\n` : '') +
                (info.role ? `┃ 🛡️ *Your Role:* ${info.role}\n` : '') +
                `╰━━━━━━━━━━━━━━━━━━━━━━┈⊷` +
                (info.description ? `\n\n📝 *Bio:* ${info.description}` : '')
            );
        }
    },
    {
        name: 'chfollow',
        aliases: ['followch', 'chf', 'followall'],
        category: 'channel',
        desc: 'WhatsApp Channel follow karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chfollow <channel-link | @newsletter JID>*`);
            await withTimeout(ctx.sock.newsletterFollow(info.jid), 10000, 'Follow');
            await ctx.reply(`✅ *Channel Followed!*\n📛 ${info.name}\n🆔 \`${info.jid}\``);
        }
    },
    {
        name: 'chunfollow',
        aliases: ['unfollowch', 'chunf', 'unfollowall'],
        category: 'channel',
        desc: 'WhatsApp Channel unfollow karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chunfollow <channel-link | @newsletter JID>*`);
            await withTimeout(ctx.sock.newsletterUnfollow(info.jid), 10000, 'Unfollow');
            await ctx.reply(`🗑️ *Channel Unfollowed:* ${info.name}`);
        }
    },
    {
        name: 'chmute',
        aliases: ['mutech'],
        category: 'channel',
        desc: 'Channel notifications mute karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chmute <channel-link | @newsletter JID>*`);
            await withTimeout(ctx.sock.newsletterMute(info.jid), 10000, 'Mute');
            await ctx.reply(`🔇 *Channel Muted:* ${info.name}`);
        }
    },
    {
        name: 'chunmute',
        aliases: ['unmutech'],
        category: 'channel',
        desc: 'Channel notifications unmute karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chunmute <channel-link | @newsletter JID>*`);
            await withTimeout(ctx.sock.newsletterUnmute(info.jid), 10000, 'Unmute');
            await ctx.reply(`🔔 *Channel Unmuted:* ${info.name}`);
        }
    },
    {
        name: 'chreact',
        aliases: ['react', 'reactch', 'channelreact', 'creact', 'rch', 'chreaction'],
        category: 'channel',
        desc: 'All servers se Channel post par emoji react karein (.chreact / .react <post-link> ❤️)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const argsStr = (ctx.args || []).join(' ');
            const hasExplicitTargetInArgs = /(?:whatsapp\.com\/channel\/|[0-9]{10,}@newsletter)/i.test(argsStr);
            const parsed = parseMiniChannelInput(ctx.args, ctx.msg, '❤️');
            const lookupToken = parsed.code
                ? `https://whatsapp.com/channel/${parsed.code}${parsed.postId ? '/' + parsed.postId : ''}`
                : (parsed.jid || ctx.args[0] || '');
            const info = await resolveChannelTarget(ctx.sock, lookupToken, hasExplicitTargetInArgs ? null : ctx.msg).catch(() => null);
            let jid = info?.jid || parsed.jid;
            let code = info?.inviteCode || parsed.code;
            const serverId = parsed.postId || info?.postId;
            const chName = info?.name || parsed.name;

            if (!jid && code) {
                const cRes = await resolveFromMiniCluster('resolve_channel', { code }, d => d?.jid && /^\d+@newsletter$/.test(d.jid));
                if (cRes?.jid) jid = cRes.jid;
            }
            if ((!jid && !code) || !serverId) {
                // Support `.react 🔥` when replying to a normal (non-channel) chat message
                if (ctx.commandName === 'react' && ctx.quotedMsg && (ctx.args || []).length > 0 && !parsed.code && !parsed.jid) {
                    const mCtx = getContextInfo(unwrapMessage(ctx.msg?.message));
                    if (mCtx?.stanzaId) {
                        const targetKey = {
                            remoteJid: ctx.from,
                            fromMe: mCtx.participant && ctx.sock?.user?.id ? mCtx.participant.split('@')[0].split(':')[0] === ctx.sock.user.id.split('@')[0].split(':')[0] : false,
                            id: mCtx.stanzaId,
                            ...(ctx.isGroup && mCtx.participant ? { participant: mCtx.participant } : {})
                        };
                        const emojiToken = String(parsed.extraText || ctx.args[0] || '❤️').split(/[\s,]+/)[0] || '❤️';
                        await ctx.sock.sendMessage(ctx.from, { react: { text: emojiToken, key: targetKey } }).catch(() => {});
                        return;
                    }
                }
                return ctx.reply(
                    `📢 *SIGMA MD — CHANNEL POST REACT*\n\n` +
                    `📌 *Dono Commands & Tarike Working Hain:*\n` +
                    `• *${ctx.prefix}chreact https://whatsapp.com/channel/CODE/123 ❤️* ya *${ctx.prefix}react <link> ❤️*\n` +
                    `• *${ctx.prefix}react ❤️ <link>* ya *${ctx.prefix}chreact ❤️ <link>*\n` +
                    `• Ya channel post par reply karke *${ctx.prefix}react 🔥* / *${ctx.prefix}chreact 🔥* likhein!`
                );
            }

            const emojiTokens = String(parsed.extraText || '❤️').split(/[\s,]+/).filter(Boolean);
            const emojiPool = emojiTokens.length ? emojiTokens : ['❤️'];
            const primaryEmoji = emojiPool[0];

            ctx.react('⏳');
            broadcastToMiniCluster('chreact', {
                jid,
                code: code || null,
                serverId: String(serverId),
                emojiPool,
                customEmojis: emojiPool,
                hasCustomEmoji: true,
                emoji: primaryEmoji,
                channelName: chName
            }).catch(() => {});

            if (jid && /^\d+@newsletter$/.test(jid)) {
                await withTimeout(ctx.sock.newsletterReactMessage(jid, String(serverId), primaryEmoji), 5000, 'Channel react').catch(() => {});
            }

            ctx.react('✅');
            await ctx.reply(
                `✅ *REACTIONS SENT ACROSS ALL ${CLUSTER_URLS.length} SERVERS!*\n\n` +
                `🎯 *Channel:* ${chName}\n` +
                `📝 *Post:* #${serverId}\n` +
                `😊 *Emoji:* ${emojiPool.join(' ')}\n` +
                `🖥️ *Cluster:* All ${CLUSTER_URLS.length} Servers + SIGMA MD`
            );
        }
    },
    {
        name: 'chvote',
        aliases: ['channelvote', 'vote'],
        category: 'channel',
        desc: 'All servers se Channel Poll par vote karein (.chvote <post-link> 1)',
        ownerOnly: true,
        handler: async (ctx) => handleMiniChvote(ctx, null)
    },
    {
        name: 'vote1',
        aliases: ['v1'],
        category: 'channel',
        desc: 'All servers se Option 1 par vote karein',
        ownerOnly: true,
        handler: async (ctx) => handleMiniChvote(ctx, '1')
    },
    {
        name: 'vote2',
        aliases: ['v2'],
        category: 'channel',
        desc: 'All servers se Option 2 par vote karein',
        ownerOnly: true,
        handler: async (ctx) => handleMiniChvote(ctx, '2')
    },
    {
        name: 'vote3',
        aliases: ['v3'],
        category: 'channel',
        desc: 'All servers se Option 3 par vote karein',
        ownerOnly: true,
        handler: async (ctx) => handleMiniChvote(ctx, '3')
    },
    {
        name: 'vote4',
        aliases: ['v4'],
        category: 'channel',
        desc: 'All servers se Option 4 par vote karein',
        ownerOnly: true,
        handler: async (ctx) => handleMiniChvote(ctx, '4')
    },
    {
        name: 'chcreate',
        aliases: ['newchannel'],
        category: 'channel',
        desc: 'Naya WhatsApp Channel banayein (.chcreate Name | Desc)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const [name, desc] = splitPipeArgs(ctx.fullArgs);
            if (!name) return ctx.reply(`Usage: *${ctx.prefix}chcreate Tech Updates | Daily News*`);
            const created = await ctx.sock.newsletterCreate(name, desc || '');
            await ctx.reply(
                `🎉 *Naya WhatsApp Channel Ban Gaya!*\n` +
                `📛 *Name:* ${created.name}\n` +
                `🆔 *JID:* \`${created.id}\`\n` +
                (created.invite ? `🔗 *Link:* https://whatsapp.com/channel/${created.invite}` : '')
            );
        }
    },
    {
        name: 'chname',
        aliases: ['setchname'],
        category: 'channel',
        desc: 'Apne channel ka naam update karein (.chname <link|jid> | New Name)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const [targetPart, newName] = splitPipeArgs(ctx.fullArgs);
            const info = await resolveChannelTarget(ctx.sock, targetPart, ctx.msg);
            if (!info || !newName) return ctx.reply(`Usage: *${ctx.prefix}chname <link|jid> | Naya Naam*`);
            await ctx.sock.newsletterUpdateName(info.jid, newName);
            await ctx.reply(`✅ Channel name update ho kar *${newName}* ho gaya!`);
        }
    },
    {
        name: 'chdesc',
        aliases: ['setchdesc'],
        category: 'channel',
        desc: 'Apne channel ki description update karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const [targetPart, newDesc] = splitPipeArgs(ctx.fullArgs);
            const info = await resolveChannelTarget(ctx.sock, targetPart, ctx.msg);
            if (!info || !newDesc) return ctx.reply(`Usage: *${ctx.prefix}chdesc <link|jid> | New Description*`);
            await ctx.sock.newsletterUpdateDescription(info.jid, newDesc);
            await ctx.reply(`✅ Channel description update ho gayi for *${info.name}*!`);
        }
    },
    {
        name: 'chsetpp',
        aliases: ['setchpp'],
        category: 'channel',
        desc: 'Reply ki gayi image se channel icon update karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!info || !media || media.mediaType !== 'image') {
                return ctx.reply(`Usage: Image par reply karke *${ctx.prefix}chsetpp <channel-link|jid>* chalayein.`);
            }
            await ctx.sock.newsletterUpdatePicture(info.jid, media.buffer);
            await ctx.reply(`✅ Channel profile picture update ho gayi for *${info.name}*!`);
        }
    },
    {
        name: 'chdelpp',
        aliases: ['delchpp'],
        category: 'channel',
        desc: 'Channel icon remove karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chdelpp <channel-link|jid>*`);
            await ctx.sock.newsletterRemovePicture(info.jid);
            await ctx.reply(`🗑️ Channel picture remove ho gayi for *${info.name}*!`);
        }
    },
    {
        name: 'channels',
        aliases: ['chadmins', 'mychannels'],
        category: 'channel',
        desc: 'Tamam subscribed & admin WhatsApp Channels list karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const list = await getSubscribedChannels(ctx.sock, false);
            if (!list.length) return ctx.reply('ℹ️ Koi subscribed ya admin channel nahi mila.');
            const lines = list.slice(0, 35).map((c, i) => `${i + 1}. *${c.name}* [${c.role}]\n   \`${c.jid}\` (${c.followers} followers)`);
            await ctx.reply(`📢 *YOUR CHANNELS (${list.length}):*\n\n${lines.join('\n')}`);
        }
    },
    {
        name: 'chsubscribers',
        aliases: ['chsubs', 'chcount'],
        category: 'channel',
        desc: 'Channel ke subscribers count aur stats dekhein',
        handler: async (ctx) => {
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chsubscribers <channel-link|jid>*`);
            let subs = info.followers;
            try {
                const res = await ctx.sock.newsletterSubscribers(info.jid);
                if (res?.subscribers != null) subs = res.subscribers;
            } catch (_) {}
            await ctx.reply(`📊 *${info.name}*\n🆔 \`${info.jid}\`\n👥 *Subscribers:* ${subs ?? 'N/A'}`);
        }
    },
    {
        name: 'chautofollow',
        aliases: ['autofollowch'],
        category: 'channel',
        desc: 'Auto-follow channel list mein add/remove/sync karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const sub = (ctx.args[0] || 'list').toLowerCase();
            const cfg = configStore.getConfig();
            const list = [...(cfg.autoFollowChannels || [])];

            if (sub === 'add' && ctx.args[1]) {
                const info = await resolveChannelTarget(ctx.sock, ctx.args[1], ctx.msg);
                if (!info) return ctx.reply('❌ Valid channel link ya JID dein.');
                if (!list.some((x) => x.jid === info.jid)) {
                    list.push({ jid: info.jid, name: info.name });
                    configStore.updateConfig({ autoFollowChannels: list });
                }
                await ctx.sock.newsletterFollow(info.jid).catch(() => {});
                return ctx.reply(`✅ *${info.name}* Auto-Follow list mein add aur follow ho gaya!`);
            }

            if (sub === 'del' && ctx.args[1]) {
                const filtered = list.filter((x) => !x.jid.includes(ctx.args[1]));
                configStore.updateConfig({ autoFollowChannels: filtered });
                return ctx.reply(`🗑️ Auto-follow list updated (${filtered.length} channels remaining).`);
            }

            if (sub === 'run') {
                let done = 0;
                for (const ch of list) {
                    try {
                        await ctx.sock.newsletterFollow(ch.jid);
                        done++;
                        await sleep(600);
                    } catch (_) {}
                }
                return ctx.reply(`⚡ Auto-Follow run completed: *${done}/${list.length}* channels followed.`);
            }

            if (!list.length) {
                return ctx.reply(`ℹ️ Auto-Follow list khali hai.\nAdd: *${ctx.prefix}chautofollow add <link>*`);
            }
            await ctx.reply(
                `📌 *AUTO-FOLLOW CHANNELS (${list.length}):*\n\n` +
                list.map((c, i) => `${i + 1}. *${c.name}*\n   \`${c.jid}\``).join('\n') +
                `\n\nCommands: \`add <link>\` | \`del <jid>\` | \`run\``
            );
        }
    },
    {
        name: 'setchannel',
        aliases: ['setnewsletter', 'viewchannel'],
        category: 'channel',
        desc: 'Bot replies ke neeche "View Channel" forward card channel set karein (Owner)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const cfg = configStore.getConfig();
            if (!ctx.fullArgs) {
                return ctx.reply(
                    `📢 *CURRENT VIEW-CHANNEL CARD:*\n` +
                    `• *Channel Name:* ${cfg.newsletterName}\n` +
                    `• *Newsletter JID:* \`${cfg.newsletterJid}\`\n` +
                    `• *Status:* ${cfg.channelCardEnabled ? 'ON' : 'OFF'}\n\n` +
                    `Usage:\n` +
                    `• *${ctx.prefix}setchannel <channel-link | @newsletter JID>*\n` +
                    `• *${ctx.prefix}setchannel <link> | Custom Name*\n` +
                    `• *${ctx.prefix}channelcard on/off*`
                );
            }
            const [targetPart, customName] = splitPipeArgs(ctx.fullArgs);
            const info = await resolveChannelTarget(ctx.sock, targetPart || ctx.args[0], ctx.msg);
            if (!info?.jid) return ctx.reply(`❌ Valid WhatsApp Channel link ya \`@newsletter\` JID dein (ya channel post par reply karein).`);
            const nameToSet = customName || info.name || cfg.newsletterName;
            configStore.updateConfig({
                newsletterJid: info.jid,
                newsletterName: nameToSet,
                channelCardEnabled: true
            });
            await ctx.reply(
                `✅ *View Channel Forward Card Updated!*\n` +
                `📛 *Channel:* ${nameToSet}\n` +
                `🆔 *JID:* \`${info.jid}\`\n\n` +
                `_Ab har reply ke neeche aapka "View channel" pill dikhega!_`
            );
        }
    },
    {
        name: 'channelcard',
        aliases: ['viewcard', 'nlcard'],
        category: 'channel',
        desc: 'Messages ke neeche "View Channel" forward card ON/OFF karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            const cfg = configStore.getConfig();
            if (!['on', 'off'].includes(sub)) {
                return ctx.reply(`📢 *View Channel Card:* ${cfg.channelCardEnabled ? 'ON' : 'OFF'}\nChannel: *${cfg.newsletterName}* (\`${cfg.newsletterJid}\`)`);
            }
            configStore.updateConfig({ channelCardEnabled: sub === 'on' });
            await ctx.reply(`✅ View Channel Forward Card ab *${sub.toUpperCase()}* hai.`);
        }
    }
];

module.exports = commands;
