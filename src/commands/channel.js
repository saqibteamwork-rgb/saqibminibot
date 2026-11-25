'use strict';

/**
 * MINI BOT MD :: WhatsApp Channel (@newsletter) Command Suite (16 commands)
 * Protected by strict Owner checks on mutating / channel-posting commands.
 */

const configStore = require('../configStore');
const {
    resolveChannelTarget,
    getSubscribedChannels,
    extractMedia,
    unwrapMessage,
    getTextFromContent,
    sleep,
    withTimeout
} = require('../mediaHelper');

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
        aliases: ['channelid', 'chid'],
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
        aliases: ['followch'],
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
        aliases: ['unfollowch'],
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
        aliases: ['reactch'],
        category: 'channel',
        desc: 'Channel post par emoji react karein (.chreact <post-link> ❤️)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyChannelOwner(ctx);
            const info = await resolveChannelTarget(ctx.sock, ctx.args[0] || '', ctx.msg);
            let serverId = info?.postId;
            let emoji = ctx.args[1] || '❤️';
            if (!serverId && /^\d+$/.test(ctx.args[1] || '')) {
                serverId = ctx.args[1];
                emoji = ctx.args[2] || '❤️';
            }
            if (!info?.jid || !serverId) {
                return ctx.reply(`Usage: *${ctx.prefix}chreact https://whatsapp.com/channel/CODE/123 ❤️*\nYa *${ctx.prefix}chreact <jid> <postId> 🔥*`);
            }
            await ctx.sock.newsletterFollow(info.jid).catch(() => {});
            await ctx.sock.newsletterReactMessage(info.jid, String(serverId), emoji);
            await ctx.reply(`✅ *Reacted ${emoji}* on *${info.name}* (Post #${serverId})`);
        }
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
