'use strict';

/**
 * SIGMA MD :: WhatsApp Channel (@newsletter) Command Suite (16 commands)
 * Protected by strict Owner checks on mutating / channel-posting commands.
 */

const crypto = require('crypto');
const configStore = require('../configStore');
const clusterMesh = require('../clusterMesh');
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

const getMeshCount = () => Math.max(clusterMesh.getAllMeshTargets(false).length, 1);

async function broadcastToMiniCluster(action, payload) {
    return clusterMesh.broadcastToAllClusters(action, payload);
}

async function resolveFromMiniCluster(action, payload, isValid) {
    return clusterMesh.resolveFromClusters(action, payload, isValid);
}

async function resolveChannelWithClusterFallback(ctx, rawInput = '') {
    const info = await resolveChannelTarget(ctx.sock, rawInput || '', ctx.msg).catch(() => null);
    if (info?.jid) return info;
    const parsed = parseMiniChannelInput(rawInput ? [rawInput] : [], ctx.msg, '');
    if (parsed.jid && /^\d+@newsletter$/.test(parsed.jid)) {
        return { jid: parsed.jid, name: parsed.name || 'WhatsApp Channel', inviteCode: parsed.code || null };
    }
    if (parsed.code) {
        const cRes = await clusterMesh.resolveFromClusters('resolve_channel', { code: parsed.code }, (d) => d?.jid && /^\d+@newsletter$/.test(d.jid));
        if (cRes?.jid) {
            return { jid: cRes.jid, name: cRes.name || parsed.name || 'WhatsApp Channel', inviteCode: parsed.code };
        }
    }
    return null;
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
    if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
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
    const meshCount = getMeshCount();
    return ctx.reply(
        `✅ *VOTES SENT ACROSS ALL ${meshCount} SERVERS!*\n\n` +
        `🎯 *Channel:* ${chName}\n` +
        `📝 *Post:* #${serverId}\n` +
        `🗳️ *Option:* ${selectedOptionName}\n` +
        `🖥️ *Cluster:* All ${meshCount} Servers (Main + Mini Mesh)`
    );
}

async function denyChannelOwner(ctx) {
    return await ctx.reply('🔒 Sirf *Bot Owner* Channel posting / management commands chala sakta hai!');
}

function hasMasterChannelAccess(ctx) {
    if (ctx.isMasterOwner === true) return true;
    if (ctx.tenantConfig?.creatorId) return false;
    return Boolean(ctx.isOwner);
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
        desc: 'All Main + Mini servers se WhatsApp Channel follow karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
            const info = await resolveChannelWithClusterFallback(ctx, ctx.args[0] || '');
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chfollow <channel-link | @newsletter JID>*`);
            ctx.react('⏳');
            await withTimeout(ctx.sock.newsletterFollow(info.jid), 10000, 'Follow').catch(() => {});
            await ctx.sock.subscribeNewsletterUpdates?.(info.jid).catch(() => {});
            clusterMesh.broadcastToAllClusters('chfollow', {
                jid: info.jid,
                code: info.inviteCode || null,
                input: ctx.args[0] || info.jid,
                channelName: info.name
            }).catch(() => {});
            ctx.react('✅');
            const meshCount = getMeshCount();
            await ctx.reply(
                `✅ *Channel Followed Across All ${meshCount} Servers!*\n` +
                `📛 *Channel:* ${info.name}\n` +
                `🆔 \`${info.jid}\`\n` +
                `🌐 *Sync:* Main Bot + Mini Bot Cluster`
            );
        }
    },
    {
        name: 'chunfollow',
        aliases: ['unfollowch', 'chunf', 'unfollowall'],
        category: 'channel',
        desc: 'All Main + Mini servers se WhatsApp Channel unfollow karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
            const info = await resolveChannelWithClusterFallback(ctx, ctx.args[0] || '');
            if (!info) return ctx.reply(`Usage: *${ctx.prefix}chunfollow <channel-link | @newsletter JID>*`);
            ctx.react('⏳');
            await withTimeout(ctx.sock.newsletterUnfollow(info.jid), 10000, 'Unfollow').catch(() => {});
            clusterMesh.broadcastToAllClusters('chunfollow', {
                jid: info.jid,
                code: info.inviteCode || null,
                input: ctx.args[0] || info.jid
            }).catch(() => {});
            ctx.react('✅');
            const meshCount = getMeshCount();
            await ctx.reply(`🗑️ *Channel Unfollowed Across All ${meshCount} Servers:* ${info.name}`);
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
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
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
            const meshCount = getMeshCount();
            await ctx.reply(
                `✅ *REACTIONS SENT ACROSS ALL ${meshCount} SERVERS!*\n\n` +
                `🎯 *Channel:* ${chName}\n` +
                `📝 *Post:* #${serverId}\n` +
                `😊 *Emoji:* ${emojiPool.join(' ')}\n` +
                `🖥️ *Cluster:* All ${meshCount} Servers (Main + Mini Mesh)`
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
        aliases: ['autofollowch', 'afc', 'delafc', 'afclist', 'chsync'],
        category: 'channel',
        desc: 'Cross-bot Auto-Follow channel list add/del/list/sync karein (Main + Mini)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
            const cmd = (ctx.commandName || '').toLowerCase();
            let sub = (ctx.args[0] || '').toLowerCase();
            let targetArg = ctx.args[1] || '';

            if (cmd === 'delafc') {
                sub = 'del';
                targetArg = ctx.args[0] || '';
            } else if (cmd === 'afclist') {
                sub = 'list';
            } else if (cmd === 'chsync' || sub === 'sync') {
                sub = 'run';
            } else if (!sub) {
                sub = 'list';
            } else if (sub !== 'add' && sub !== 'del' && sub !== 'delete' && sub !== 'remove' && sub !== 'rm' && sub !== 'run' && sub !== 'list') {
                sub = 'add';
                targetArg = ctx.args[0] || '';
            }

            const cfg = configStore.getConfig();
            const list = [...(cfg.autoFollowChannels || [])];

            if (sub === 'add') {
                const info = await resolveChannelWithClusterFallback(ctx, targetArg);
                if (!info) {
                    return ctx.reply(`❌ Valid channel link ya JID dein.\nExample: *${ctx.prefix}afc https://whatsapp.com/channel/CODE*`);
                }
                const entry = {
                    jid: info.jid,
                    name: info.name,
                    link: targetArg && targetArg.includes('whatsapp.com/channel/') ? targetArg : '',
                    code: info.inviteCode || '',
                    addedAt: Date.now()
                };
                if (!list.some((x) => x.jid === info.jid)) {
                    list.push(entry);
                    configStore.updateConfig({ autoFollowChannels: list });
                }
                await ctx.sock.newsletterFollow?.(info.jid).catch(() => {});
                await ctx.sock.subscribeNewsletterUpdates?.(info.jid).catch(() => {});
                clusterMesh.broadcastToAllClusters('sync_auto_follow', {
                    action: 'add',
                    channel: entry
                }).catch(() => {});
                const meshCount = getMeshCount();
                return ctx.reply(
                    `✅ *${info.name}* Cross-Bot Auto-Follow mein add ho gaya!\n` +
                    `🆔 \`${info.jid}\`\n` +
                    `🌐 *Synced Across:* Main Bot + Mini Bot (${meshCount} Servers)`
                );
            }

            if (sub === 'del' || sub === 'delete' || sub === 'remove' || sub === 'rm') {
                if (!targetArg) {
                    return ctx.reply(`Usage: *${ctx.prefix}delafc <link | @newsletter JID | number>*`);
                }
                let delJid = targetArg.trim();
                if (/^\d+$/.test(delJid) && Number(delJid) >= 1 && Number(delJid) <= list.length) {
                    delJid = list[Number(delJid) - 1].jid;
                } else if (!/^\d+@newsletter$/.test(delJid)) {
                    const resolved = await resolveChannelWithClusterFallback(ctx, targetArg).catch(() => null);
                    if (resolved?.jid) delJid = resolved.jid;
                }
                const removed = list.find((x) => x.jid === delJid || x.jid.includes(delJid));
                const filtered = removed ? list.filter((x) => x.jid !== removed.jid) : list;
                configStore.updateConfig({ autoFollowChannels: filtered });
                clusterMesh.broadcastToAllClusters('sync_auto_follow', {
                    action: 'del',
                    jid: removed?.jid || delJid
                }).catch(() => {});
                return ctx.reply(`🗑️ Auto-follow removed${removed ? ` (*${removed.name}*)` : ''} & synced (${filtered.length} remaining).`);
            }

            if (sub === 'run') {
                let done = 0;
                for (const ch of list) {
                    try {
                        await ctx.sock.newsletterFollow?.(ch.jid);
                        await ctx.sock.subscribeNewsletterUpdates?.(ch.jid).catch(() => {});
                        done++;
                        await sleep(600);
                    } catch (_) {}
                }
                const channelsMap = Object.fromEntries(list.map((c) => [c.jid, c]));
                clusterMesh.broadcastToAllClusters('sync_auto_follow', {
                    action: 'sync',
                    data: { channels: channelsMap, updatedAt: Date.now() }
                }).catch(() => {});
                return ctx.reply(`⚡ Cross-Bot Auto-Follow sync completed: *${done}/${list.length}* local + broadcasted to ${getMeshCount()} servers.`);
            }

            if (!list.length) {
                return ctx.reply(`ℹ️ Auto-Follow list khali hai.\nAdd: *${ctx.prefix}afc <link>* ya *${ctx.prefix}chautofollow add <link>*`);
            }
            await ctx.reply(
                `📌 *CROSS-BOT AUTO-FOLLOW CHANNELS (${list.length}):*\n\n` +
                list.map((c, i) => `${i + 1}. *${c.name}*\n   \`${c.jid}\``).join('\n') +
                `\n\nCommands: \`${ctx.prefix}afc <link>\` | \`${ctx.prefix}delafc <jid|num>\` | \`${ctx.prefix}chsync\``
            );
        }
    },
    {
        name: 'arc',
        aliases: ['autochreact', 'chautoreact', 'autoreactch', 'arclist', 'arcdel'],
        category: 'channel',
        desc: 'Cross-bot Auto Channel Reaction setup (Main + Mini Bot dono par auto-react)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
            const cmd = (ctx.commandName || '').toLowerCase();
            const cfg = configStore.getConfig();
            const arcMap = { ...(cfg.arcChannels || {}) };
            let sub = (ctx.args[0] || '').toLowerCase();

            if (cmd === 'arclist' || sub === 'list' || sub === 'ls') {
                const entries = Object.values(arcMap);
                if (!entries.length) {
                    return ctx.reply(
                        `ℹ️ *ARC List khali hai.*\n` +
                        `Add: *${ctx.prefix}arc https://whatsapp.com/channel/CODE ❤️ 🔥 👍*\n` +
                        `Ya: *${ctx.prefix}autoreact https://whatsapp.com/channel/CODE ❤️*`
                    );
                }
                return ctx.reply(
                    `⚡ *CROSS-BOT AUTO CHANNEL REACTIONS (${entries.length}):*\n\n` +
                    entries.map((c, i) => `${i + 1}. *${c.name}* (${c.enabled === false ? 'OFF' : 'ON'})\n   🆔 \`${c.jid}\` | 😊 ${(c.emojis || ['❤️']).join(' ')}`).join('\n') +
                    `\n\nRemove: \`${ctx.prefix}arcdel <jid|num>\` | Toggle: \`${ctx.prefix}arc on/off\``
                );
            }

            if (cmd === 'arcdel' || sub === 'del' || sub === 'delete' || sub === 'rm' || sub === 'remove') {
                const targetArg = (cmd === 'arcdel' ? ctx.args[0] : ctx.args[1]) || '';
                if (!targetArg) return ctx.reply(`Usage: *${ctx.prefix}arcdel <channel-link | @newsletter JID | number>*`);
                const entries = Object.values(arcMap);
                let targetJid = targetArg.trim();
                if (/^\d+$/.test(targetJid) && Number(targetJid) >= 1 && Number(targetJid) <= entries.length) {
                    targetJid = entries[Number(targetJid) - 1].jid;
                } else if (!/^\d+@newsletter$/.test(targetJid)) {
                    const resolved = await resolveChannelTarget(ctx.sock, targetArg, ctx.msg).catch(() => null);
                    if (resolved?.jid) targetJid = resolved.jid;
                }
                if (!arcMap[targetJid]) {
                    return ctx.reply(`❌ ARC list mein \`${targetArg}\` nahi mila.`);
                }
                const removedName = arcMap[targetJid].name || targetJid;
                delete arcMap[targetJid];
                configStore.updateConfig({ arcChannels: arcMap });
                clusterMesh.broadcastToAllClusters('sync_channel_arc', { op: 'del', jid: targetJid }).catch(() => {});
                return ctx.reply(`🗑️ *${removedName}* ko Main + Mini Bot ARC list se delete kar diya!`);
            }

            if (sub === 'on' || sub === 'off') {
                const enabled = sub === 'on';
                for (const key of Object.keys(arcMap)) {
                    arcMap[key].enabled = enabled;
                }
                configStore.updateConfig({ arcChannels: arcMap });
                if (enabled) await clusterMesh.syncAllNewsletterSubscriptions(ctx.sock).catch(() => {});
                for (const key of Object.keys(arcMap)) {
                    clusterMesh.broadcastToAllClusters('sync_channel_arc', { op: 'toggle', jid: key, enabled }).catch(() => {});
                }
                return ctx.reply(`✅ Cross-Bot Channel Auto-React ab *${sub.toUpperCase()}* hai!`);
            }

            const rawArgs = sub === 'add' ? ctx.args.slice(1) : [...(ctx.args || [])];
            const parsed = parseMiniChannelInput(rawArgs, ctx.msg, '❤️ 🔥 👍');
            const lookupToken = parsed.code
                ? `https://whatsapp.com/channel/${parsed.code}`
                : (parsed.jid || rawArgs[0] || '');
            const info = await resolveChannelTarget(ctx.sock, lookupToken, ctx.msg).catch(() => null);
            let jid = info?.jid || parsed.jid;
            if (!jid && parsed.code) {
                const cRes = await clusterMesh.resolveFromClusters('resolve_channel', { code: parsed.code }, (d) => d?.jid && /^\d+@newsletter$/.test(d.jid));
                if (cRes?.jid) jid = cRes.jid;
            }
            if (!jid) {
                return ctx.reply(
                    `📢 *CROSS-BOT AUTO CHANNEL REACT (.arc)*\n\n` +
                    `• *${ctx.prefix}arc https://whatsapp.com/channel/CODE ❤️ 🔥 👍*\n` +
                    `• *${ctx.prefix}arclist* | *${ctx.prefix}arcdel <link|num>*\n` +
                    `• *${ctx.prefix}arc on* | *${ctx.prefix}arc off*\n\n` +
                    `✨ _Is se add kiya channel Main Bot (50 servers) aur Mini Bot dono par auto-react karega!_`
                );
            }

            const emojiTokens = String(parsed.extraText || '❤️ 🔥 👍').split(/[\s,]+/).filter(Boolean);
            const emojis = emojiTokens.length ? emojiTokens : ['❤️', '🔥', '👍'];
            const entry = {
                jid,
                name: info?.name || parsed.name || 'WhatsApp Channel',
                link: parsed.code ? `https://whatsapp.com/channel/${parsed.code}` : '',
                invite: parsed.code || info?.inviteCode || '',
                emojis,
                enabled: true,
                addedAt: Date.now()
            };
            arcMap[jid] = entry;
            configStore.updateConfig({ arcChannels: arcMap });
            await ctx.sock.newsletterFollow?.(jid).catch(() => {});
            await clusterMesh.syncAllNewsletterSubscriptions(ctx.sock).catch(() => {});
            clusterMesh.broadcastToAllClusters('sync_channel_arc', { op: 'add', channel: entry }).catch(() => {});
            ctx.react('✅');
            return ctx.reply(
                `✅ *CROSS-BOT AUTO CHANNEL REACT ACTIVE!*\n\n` +
                `🎯 *Channel:* ${entry.name}\n` +
                `🆔 \`${entry.jid}\`\n` +
                `😊 *Emojis:* ${emojis.join(' ')}\n` +
                `🌐 *Synced Across:* Main Bot + Mini Bot (${getMeshCount()} Servers)`
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
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
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
    },
    {
        name: 'chreactall',
        aliases: ['reactallch', 'allreact'],
        category: 'channel',
        desc: 'Channel ke recent 5 posts par all servers se react karein (.chreactall <link> 🔥)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
            const parsed = parseMiniChannelInput(ctx.args, ctx.msg, '🔥');
            const lookup = parsed.code ? `https://whatsapp.com/channel/${parsed.code}` : (parsed.jid || ctx.args[0] || '');
            const info = await resolveChannelTarget(ctx.sock, lookup, ctx.msg).catch(() => null);
            const jid = info?.jid || parsed.jid;
            const code = info?.inviteCode || parsed.code;
            const chName = info?.name || parsed.name;
            if (!jid) return ctx.reply(`Usage: *${ctx.prefix}chreactall <channel-link | @newsletter JID> [emoji]*`);

            const emojiTokens = String(parsed.extraText || '🔥').split(/[\s,]+/).filter(Boolean);
            const emojiPool = emojiTokens.length ? emojiTokens : ['🔥'];
            const primaryEmoji = emojiPool[0];
            ctx.react('⏳');

            let posts = [];
            try {
                if (typeof ctx.sock.newsletterFetchMessages === 'function') {
                    const fetched = await withTimeout(ctx.sock.newsletterFetchMessages('jid', jid, 5), 8000, 'Fetch posts');
                    if (Array.isArray(fetched)) {
                        posts = fetched.map(m => String(m?.server_id || m?.key?.server_id || m?.attrs?.server_id || '')).filter(Boolean);
                    }
                }
            } catch (_) {}

            if (!posts.length && (parsed.postId || info?.postId)) {
                posts = [String(parsed.postId || info?.postId)];
            }
            if (!posts.length) {
                return ctx.reply(`❌ Channel ke recent posts fetch nahi ho sake. Post link ke sath *${ctx.prefix}chreact* use karein.`);
            }

            let okCount = 0;
            for (const sid of posts.slice(0, 5)) {
                broadcastToMiniCluster('chreact', {
                    jid,
                    code: code || null,
                    serverId: sid,
                    emojiPool,
                    customEmojis: emojiPool,
                    hasCustomEmoji: true,
                    emoji: primaryEmoji,
                    channelName: chName
                }).catch(() => {});
                await withTimeout(ctx.sock.newsletterReactMessage(jid, sid, primaryEmoji), 4500, 'React all').catch(() => {});
                okCount++;
                await sleep(900);
            }
            ctx.react('✅');
            await ctx.reply(`✅ *${okCount} Channel Posts* par ${emojiPool.join(' ')} reaction sent across all ${getMeshCount()} servers!`);
        }
    },
    {
        name: 'chunreact',
        aliases: ['unreactch', 'rmreact'],
        category: 'channel',
        desc: 'Channel post se apna emoji reaction hatayein (.chunreact <post-link>)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!hasMasterChannelAccess(ctx)) return denyChannelOwner(ctx);
            const parsed = parseMiniChannelInput(ctx.args, ctx.msg, '');
            const lookup = parsed.code
                ? `https://whatsapp.com/channel/${parsed.code}${parsed.postId ? '/' + parsed.postId : ''}`
                : (parsed.jid || ctx.args[0] || '');
            const info = await resolveChannelTarget(ctx.sock, lookup, ctx.msg).catch(() => null);
            const jid = info?.jid || parsed.jid;
            const code = info?.inviteCode || parsed.code;
            const serverId = parsed.postId || info?.postId;
            if ((!jid && !code) || !serverId) {
                return ctx.reply(`Usage: *${ctx.prefix}chunreact <channel-post-link>* ya channel post par reply karein.`);
            }
            ctx.react('⏳');
            broadcastToMiniCluster('chreact', {
                jid,
                code: code || null,
                serverId: String(serverId),
                emojiPool: [''],
                customEmojis: [''],
                hasCustomEmoji: true,
                emoji: ''
            }).catch(() => {});
            if (jid && /^\d+@newsletter$/.test(jid)) {
                await withTimeout(ctx.sock.newsletterReactMessage(jid, String(serverId), ''), 5000, 'Channel unreact').catch(() => {});
            }
            ctx.react('✅');
            await ctx.reply(`✅ *Reaction Removed!* Channel Post #${serverId}`);
        }
    },
    {
        name: 'pollvote',
        aliases: ['votepoll'],
        category: 'channel',
        desc: 'Quoted ya linked Channel/Group Poll par vote karein (.pollvote 1)',
        ownerOnly: true,
        handler: async (ctx) => handleMiniChvote(ctx, null)
    },
    {
        name: 'pollrand',
        aliases: ['randomvote', 'randvote'],
        category: 'channel',
        desc: 'Quoted Channel Poll par random option par vote karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const qPoll = ctx.quotedMsg ? extractPollOptsFromObj(ctx.quotedMsg) : null;
            const totalOpts = qPoll?.options?.length || 2;
            const pickIdx = Math.floor(Math.random() * totalOpts) + 1;
            return handleMiniChvote(ctx, String(pickIdx));
        }
    },
    {
        name: 'pollunvote',
        aliases: ['unvote', 'rmvote'],
        category: 'channel',
        desc: 'Quoted Channel Poll se apna vote hatayein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const unwrapped = unwrapMessage(ctx.msg?.message);
            const mCtx = getContextInfo(unwrapped);
            const fnmi = mCtx?.forwardedNewsletterMessageInfo || getContextInfo(unwrapMessage(ctx.quotedMsg))?.forwardedNewsletterMessageInfo;
            const parsed = parseMiniChannelInput(ctx.args, ctx.msg, '');
            const jid = fnmi?.newsletterJid || parsed.jid;
            const serverId = fnmi?.serverMessageId || fnmi?.newsletterServerMessageId || parsed.postId;

            if (!jid || !serverId || !/^\d+@newsletter$/.test(jid)) {
                return ctx.reply(`ℹ️ Kisi forwarded *Channel Poll* par reply karke *${ctx.prefix}pollunvote* likhein.`);
            }
            if (typeof ctx.sock.query === 'function') {
                const msgId = typeof ctx.sock.generateMessageTag === 'function' ? ctx.sock.generateMessageTag() : `${Date.now()}`;
                await withTimeout(ctx.sock.query({
                    tag: 'message',
                    attrs: { to: jid, id: msgId, type: 'poll', server_id: String(serverId) },
                    content: [
                        { tag: 'meta', attrs: { polltype: 'vote' } },
                        { tag: 'votes', attrs: {}, content: [] }
                    ]
                }), 5000, 'Channel poll unvote').catch(() => {});
            }
            await ctx.reply(`✅ *Channel Poll Unvoted!* (Post #${serverId})`);
        }
    },
    {
        name: 'pollvinfo',
        aliases: ['pollinfo', 'pinfo'],
        category: 'channel',
        desc: 'Quoted Channel ya Chat Poll ki options aur details dekhein',
        handler: async (ctx) => {
            const qPoll = ctx.quotedMsg ? extractPollOptsFromObj(ctx.quotedMsg) : null;
            if (!qPoll) {
                return ctx.reply(`❌ Kisi *Poll* par reply karke *${ctx.prefix}pollvinfo* likhein!`);
            }
            const unwrapped = unwrapMessage(ctx.msg?.message);
            const mCtx = getContextInfo(unwrapped);
            const fnmi = mCtx?.forwardedNewsletterMessageInfo || getContextInfo(unwrapMessage(ctx.quotedMsg))?.forwardedNewsletterMessageInfo;
            const optsText = qPoll.options.map((opt, idx) => `┃  ${idx + 1}. *${opt}*`).join('\n');
            await ctx.reply(
                `╭━━━〔 📊 *POLL INFORMATION* 〕━━━┈⊷\n` +
                `┃ ❓ *Question:* ${qPoll.name}\n` +
                `┃ 📺 *Type:* ${fnmi?.newsletterJid ? '📢 Channel Poll' : '💬 Chat Poll'}\n` +
                `┃ 🔢 *Options:* ${qPoll.options.length}\n` +
                `${optsText}\n` +
                (fnmi?.newsletterJid ? `┃ 🆔 *Channel:* \`${fnmi.newsletterJid}\`\n` : '') +
                (fnmi?.serverMessageId ? `┃ 📌 *Post:* #${fnmi.serverMessageId}\n` : '') +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷`
            );
        }
    }
];

module.exports = commands;
