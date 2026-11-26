'use strict';

/**
 * SIGMA MD :: Owner & System Management Commands (26 commands)
 * Protected by strict Owner / Sudo authorization.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const configStore = require('../configStore');
const {
    extractTargetJid,
    resolveJidToDigits,
    extractMedia,
    unwrapMessage,
    getContextInfo,
    sleep,
    formatUptime,
    toSansBold,
    getPrimaryOwnerDigits,
    formatReadablePhone,
    sendMediaOrTextCard,
    sendSeparateLinksCard,
    setCustomMenuImageBuffer,
    resetCustomMenuImageBuffer,
    hasCustomMenuImage
} = require('../mediaHelper');

async function denyNonOwner(ctx) {
    return await ctx.reply(
        '╭━━━〔 🔒 *OWNER ONLY* 〕━━━┈⊷\n' +
        '┃ ❌ Sirf Bot Owner ye command chala sakta hai!\n' +
        '╰━━━━━━━━━━━━━━━━━━━━━━┈⊷'
    );
}

async function resolveDigitsFromArgsOrQuote(ctx) {
    const { sock, msg, args, content, groupMeta } = ctx;
    const jid = extractTargetJid(msg, args, content, groupMeta);
    if (!jid) return null;
    const unwrapped = unwrapMessage(msg.message);
    const mCtx = getContextInfo(unwrapped);
    const digits = await resolveJidToDigits(sock, jid, mCtx?.participantAlt || null, groupMeta);
    return { jid, digits };
}

const commands = [
    {
        name: 'owner',
        aliases: ['onwer', 'dev', 'developer', 'creator', 'contact', 'ownerinfo'],
        category: 'owner',
        desc: 'Bot owner details, phone number aur WhatsApp contact card send karein',
        ownerOnly: false,
        handler: async (ctx) => {
            ctx.react('👑');
            const cfg = configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            const ownerName = cfg.ownerName || 'MR SAQIB';
            const ownerDigits = getPrimaryOwnerDigits(cfg);
            const formattedPhone = formatReadablePhone(ownerDigits);
            const extraOwners = Array.isArray(cfg.owners)
                ? cfg.owners.filter((d) => d && d !== ownerDigits).slice(0, 3)
                : [];

            const ownerCard =
                `╭━━━〔 👑 ${toSansBold(`${ownerName} — OWNER`)} 〕━━━┈⊷\n` +
                `┃ 👤 ${toSansBold('Name')}: _Muhammad Saqib (${ownerName})_\n` +
                `┃ 📱 ${toSansBold('Owner Number')}: *${formattedPhone}*\n` +
                `┃ 💬 ${toSansBold('WhatsApp')}: https://wa.me/${ownerDigits}\n` +
                (extraOwners.length ? `┃ 🛡️ ${toSansBold('Sudo Owners')}: ${extraOwners.map((d) => `+${d}`).join(', ')}\n` : '') +
                `┃ 📍 ${toSansBold('Location')}: _Faisalabad, Pakistan_\n` +
                `┃ 💻 ${toSansBold('Role')}: _Cyber Security & Full-Stack Dev_\n` +
                `┃ 🤖 ${toSansBold('Engine')}: *${botName}* · _v2.0 Zero-Sleep_\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `➤ _${ctx.prefix}menu type karein tamam commands dekhne ke liye_`;

            await sendMediaOrTextCard(ctx, cfg, ownerCard, 'Owner');
            await sendSeparateLinksCard(ctx, cfg);

            // Deliver native WhatsApp vCard contact so owner's number can be messaged/saved in 1 tap
            const safeOwnerDisplay = String(ownerName).replace(/[\r\n;:]+/g, ' ').trim() || 'MR SAQIB';
            const safeBotDisplay = String(botName).replace(/[\r\n;:]+/g, ' ').trim() || 'SIGMA MD';
            const vcard =
                `BEGIN:VCARD\n` +
                `VERSION:3.0\n` +
                `FN:${safeOwnerDisplay}\n` +
                `ORG:${safeBotDisplay};\n` +
                `TEL;type=CELL;type=VOICE;waid=${ownerDigits}:+${ownerDigits}\n` +
                `END:VCARD`;

            const replyOpts = ctx.msg ? { quoted: ctx.msg } : ctx.quoteOpt;
            try {
                await ctx.sock.sendMessage(
                    ctx.from,
                    { contacts: { displayName: safeOwnerDisplay, contacts: [{ vcard }] } },
                    replyOpts
                );
            } catch (_) {}
        }
    },
    {
        name: 'mode',
        aliases: ['setmode'],
        category: 'owner',
        desc: 'Bot mode badlein (public / private / self)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = (ctx.args[0] || '').toLowerCase();
            if (!['public', 'private', 'self'].includes(target)) {
                return ctx.reply(`⚙️ *Current Mode:* ${configStore.getConfig().mode.toUpperCase()}\n\nUsage: *${ctx.prefix}mode public* | *private* | *self*`);
            }
            configStore.updateConfig({ mode: target });
            await ctx.reply(`✅ Bot mode ab *${target.toUpperCase()}* set ho gaya hai!`);
        }
    },
    {
        name: 'public',
        aliases: ['pub'],
        category: 'owner',
        desc: 'Bot ko public mode par karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            configStore.updateConfig({ mode: 'public' });
            await ctx.reply('🌍 Bot ab *PUBLIC* mode mein hai — sab users commands chala sakte hain.');
        }
    },
    {
        name: 'private',
        aliases: ['priv', 'self'],
        category: 'owner',
        desc: 'Bot ko private (owner-only) mode par karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            configStore.updateConfig({ mode: 'private' });
            await ctx.reply('🔒 Bot ab *PRIVATE* mode mein hai — sirf Owners commands use kar sakte hain.');
        }
    },
    {
        name: 'setprefix',
        aliases: ['prefix'],
        category: 'owner',
        desc: 'Command prefix tabdeel karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const next = (ctx.args[0] || '').trim();
            if (!next) {
                return ctx.reply(`📌 *Current Prefix:* \`${configStore.getConfig().prefix}\`\nUsage: *${ctx.prefix}setprefix !* ya *${ctx.prefix}setprefix reset*`);
            }
            const val = next.toLowerCase() === 'reset' ? '.' : next.slice(0, 3);
            configStore.updateConfig({ prefix: val });
            await ctx.reply(`✅ Command prefix ab \`${val}\` set ho gaya hai!`);
        }
    },
    {
        name: 'setbotname',
        aliases: ['botname'],
        category: 'owner',
        desc: 'Bot ka naam change karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setbotname MY SUPER BOT*`);
            configStore.updateConfig({ botName: ctx.fullArgs.slice(0, 50) });
            await ctx.reply(`✅ Bot Name update ho kar *${configStore.getConfig().botName}* ho gaya!`);
        }
    },
    {
        name: 'setownername',
        aliases: ['ownername'],
        category: 'owner',
        desc: 'Owner ka display naam change karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setownername MR SAQIB*`);
            configStore.updateConfig({ ownerName: ctx.fullArgs.slice(0, 50) });
            await ctx.reply(`✅ Owner Name update ho kar *${configStore.getConfig().ownerName}* ho gaya!`);
        }
    },
    {
        name: 'addowner',
        aliases: ['addsudo', 'ownadd', 'addown'],
        category: 'owner',
        desc: 'Naya bot owner / sudo user add karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = await resolveDigitsFromArgsOrQuote(ctx);
            if (!target?.digits) return ctx.reply(`Usage: *${ctx.prefix}addowner 923001234567* ya kisi message par reply karein.`);
            const added = configStore.addOwner(target.digits);
            await ctx.reply(added ? `✅ *+${target.digits}* ko Bot Owner add kar diya gaya!` : `ℹ️ *+${target.digits}* pehle se Owner list mein hai.`);
        }
    },
    {
        name: 'delowner',
        aliases: ['delsudo', 'owndel', 'delown', 'rmown'],
        category: 'owner',
        desc: 'Bot owner / sudo list se remove karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = await resolveDigitsFromArgsOrQuote(ctx);
            if (!target?.digits) return ctx.reply(`Usage: *${ctx.prefix}delowner 923001234567*`);
            const removed = configStore.removeOwner(target.digits);
            await ctx.reply(removed ? `🗑️ *+${target.digits}* ko Owner list se hata diya gaya.` : `⚠️ Remove nahi ho saka (Master Owner remove nahi hota ya list mein nahi).`);
        }
    },
    {
        name: 'listowners',
        aliases: ['ownlist', 'sudo', 'owners', 'listown', 'ownerlist'],
        category: 'owner',
        desc: 'Tamam Bot Owners ki list dekhein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const list = configStore.getConfig().owners;
            await ctx.reply(
                `👑 *BOT OWNERS (${list.length}):*\n\n` +
                list.map((d, i) => `${i + 1}. +${d}${i === 0 ? ' *(Master)*' : ''}`).join('\n')
            );
        }
    },
    {
        name: 'block',
        aliases: ['blk', 'blockuser'],
        category: 'owner',
        desc: 'User ko WhatsApp par block karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = await resolveDigitsFromArgsOrQuote(ctx);
            if (!target?.digits) return ctx.reply(`Usage: *${ctx.prefix}block @user* ya number likhein.`);
            await ctx.sock.updateBlockStatus(`${target.digits}@s.whatsapp.net`, 'block');
            await ctx.reply(`🚫 *+${target.digits}* ko WhatsApp par block kar diya gaya!`);
        }
    },
    {
        name: 'unblock',
        aliases: ['unblk', 'unblockuser'],
        category: 'owner',
        desc: 'User ko WhatsApp par unblock karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = await resolveDigitsFromArgsOrQuote(ctx);
            if (!target?.digits) return ctx.reply(`Usage: *${ctx.prefix}unblock 923001234567*`);
            await ctx.sock.updateBlockStatus(`${target.digits}@s.whatsapp.net`, 'unblock');
            await ctx.reply(`✅ *+${target.digits}* ko unblock kar diya gaya!`);
        }
    },
    {
        name: 'ban',
        aliases: ['botban'],
        category: 'owner',
        desc: 'User ko bot commands se ban karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = await resolveDigitsFromArgsOrQuote(ctx);
            if (!target?.digits) return ctx.reply(`Usage: *${ctx.prefix}ban @user*`);
            const ok = configStore.banUser(target.digits);
            await ctx.reply(ok ? `⛔ *+${target.digits}* ab bot use nahi kar sakta.` : `⚠️ Owner ko ban nahi kiya ja sakta.`);
        }
    },
    {
        name: 'unban',
        aliases: ['botunban'],
        category: 'owner',
        desc: 'Banned user ko unban karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const target = await resolveDigitsFromArgsOrQuote(ctx);
            if (!target?.digits) return ctx.reply(`Usage: *${ctx.prefix}unban 923001234567*`);
            const ok = configStore.unbanUser(target.digits);
            await ctx.reply(ok ? `✅ *+${target.digits}* unban ho gaya.` : `ℹ️ Ye user ban list mein nahi tha.`);
        }
    },
    {
        name: 'banlist',
        aliases: ['banned'],
        category: 'owner',
        desc: 'Bot-banned users ki list',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const banned = configStore.getConfig().banned;
            if (!banned.length) return ctx.reply('✅ Koi user ban nahi hai.');
            await ctx.reply(`⛔ *BANNED USERS (${banned.length}):*\n` + banned.map((d, i) => `${i + 1}. +${d}`).join('\n'));
        }
    },
    {
        name: 'broadcast',
        aliases: ['bc', 'bcgc', 'bcast', 'announce'],
        category: 'owner',
        desc: 'Sab joined groups mein broadcast bhejein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const text = ctx.fullArgs;
            if (!text) return ctx.reply(`Usage: *${ctx.prefix}bc <announcement message>*`);
            const groups = await ctx.sock.groupFetchAllParticipating();
            const gids = Object.keys(groups || {});
            await ctx.reply(`📣 *${gids.length}* groups mein broadcast bheja ja raha hai...`);
            let ok = 0;
            for (const gid of gids) {
                try {
                    await ctx.sock.sendMessage(gid, { text: `📢 *BROADCAST*\n\n${text}` });
                    ok++;
                    await sleep(900);
                } catch (_) {}
            }
            await ctx.reply(`✅ Broadcast mukammal: *${ok}/${gids.length}* groups mein send hua.`);
        }
    },
    {
        name: 'autoread',
        aliases: ['readall'],
        category: 'owner',
        desc: 'Auto blue-tick read receipts on/off karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(sub)) return ctx.reply(`Auto-Read: *${configStore.getConfig().autoread ? 'ON' : 'OFF'}* (${ctx.prefix}autoread on/off)`);
            configStore.updateConfig({ autoread: sub === 'on' });
            await ctx.reply(`✅ Auto-Read ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'autoviewstatus',
        aliases: ['autostatus', 'statusview'],
        category: 'owner',
        desc: 'WhatsApp Status auto-view on/off karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(sub)) return ctx.reply(`Auto-View Status: *${configStore.getConfig().autoviewStatus ? 'ON' : 'OFF'}* (${ctx.prefix}autoviewstatus on/off)`);
            configStore.updateConfig({ autoviewStatus: sub === 'on' });
            await ctx.reply(`✅ Auto-View Status ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'autotyping',
        aliases: ['typing'],
        category: 'owner',
        desc: 'Auto "typing..." presence on/off karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(sub)) return ctx.reply(`Auto-Typing: *${configStore.getConfig().autotyping ? 'ON' : 'OFF'}*`);
            configStore.updateConfig({ autotyping: sub === 'on' });
            await ctx.reply(`✅ Auto-Typing ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'autorecord',
        aliases: ['recording'],
        category: 'owner',
        desc: 'Auto "recording audio..." presence on/off',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(sub)) return ctx.reply(`Auto-Record: *${configStore.getConfig().autorecord ? 'ON' : 'OFF'}*`);
            configStore.updateConfig({ autorecord: sub === 'on' });
            await ctx.reply(`✅ Auto-Record ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'antidelete',
        aliases: ['antidel', 'ad', 'delprotect'],
        category: 'owner',
        desc: 'Deleted messages ko recover karne ka toggle',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(sub)) return ctx.reply(`Anti-Delete: *${configStore.getConfig().antidelete ? 'ON' : 'OFF'}*`);
            configStore.updateConfig({ antidelete: sub === 'on' });
            await ctx.reply(`✅ Anti-Delete ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'setbio',
        aliases: ['setabout'],
        category: 'owner',
        desc: 'Bot ka WhatsApp About/Bio update karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setbio Powered by SIGMA MD*`);
            await ctx.sock.updateProfileStatus(ctx.fullArgs.slice(0, 139));
            await ctx.reply('✅ Bot WhatsApp Bio update ho gaya!');
        }
    },
    {
        name: 'setpp',
        aliases: ['setbotpp', 'setdp', 'setpfp', 'fullpp'],
        category: 'owner',
        desc: 'Reply ki gayi image ko bot DP lagayein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const mediaSource = ctx.quotedMsg || ctx.content;
            const media = await extractMedia(mediaSource);
            if (!media || media.mediaType !== 'image') {
                return ctx.reply('❌ Kisi image par reply karke `.setpp` chalayein.');
            }
            const botJid = jidNormalizedUser(ctx.sock.user.id);
            await ctx.sock.updateProfilePicture(botJid, media.buffer);
            await ctx.reply('✅ Bot ki profile picture update ho gayi!');
        }
    },
    {
        name: 'removepp',
        aliases: ['delpp', 'cleardp', 'removebotpp'],
        category: 'owner',
        desc: 'Bot profile picture remove karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const botJid = jidNormalizedUser(ctx.sock.user.id);
            await ctx.sock.removeProfilePicture(botJid);
            await ctx.reply('🗑️ Bot profile picture remove kar di gayi!');
        }
    },
    {
        name: 'mygroups',
        aliases: ['grouplist', 'listgc'],
        category: 'owner',
        desc: 'Bot ke sab joined groups ki list',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const groups = await ctx.sock.groupFetchAllParticipating();
            const vals = Object.values(groups || {});
            if (!vals.length) return ctx.reply('ℹ️ Bot abhi kisi group mein shamil nahi hai.');
            const lines = vals.slice(0, 40).map((g, i) => `${i + 1}. *${g.subject}* (${g.participants?.length || 0} members)\n   \`${g.id}\``);
            await ctx.reply(`📋 *JOINED GROUPS (${vals.length}):*\n\n${lines.join('\n')}`);
        }
    },
    {
        name: 'backup',
        aliases: ['syncdb'],
        category: 'owner',
        desc: 'Manual session & config backup MongoDB par bhejein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const ok = await ctx.runtime.forceCloudBackup();
            await ctx.reply(ok ? '☁️ Session aur Config MongoDB Atlas par safely backup ho gaye!' : '⚠️ `MONGODB_URI` configured nahi hai ya backup skip hua.');
        }
    },
    {
        name: 'clearram',
        aliases: ['gc'],
        category: 'owner',
        desc: 'Cache clear aur Garbage Collection chalayein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const before = ctx.runtime.getMemoryUsageMb();
            ctx.runtime.trimCaches();
            if (global.gc) {
                try { global.gc(); } catch (_) {}
            }
            const after = ctx.runtime.getMemoryUsageMb();
            await ctx.reply(`🧹 *Memory Optimized!*\n• Before: ${before} MB\n• After: ${after} MB`);
        }
    },
    {
        name: 'restart',
        aliases: ['reboot', 'res', 'restartbot'],
        category: 'owner',
        desc: 'Bot process ko clean restart karein (Heroku auto-boots)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            await ctx.reply(`🔄 *Restarting ${configStore.getConfig().botName}...* (Uptime tha: ${formatUptime(ctx.runtime.getUptimeSec())})`);
            await ctx.runtime.forceCloudBackup().catch(() => {});
            setTimeout(() => process.exit(0), 1000);
        }
    },
    {
        name: 'anticall',
        aliases: ['acall', 'nocall', 'blockcall'],
        category: 'owner',
        desc: 'Incoming WhatsApp voice/video calls auto-reject karein (on/off)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const sub = (ctx.args[0] || '').toLowerCase();
            const cfg = configStore.getConfig();
            if (!['on', 'off'].includes(sub)) {
                return ctx.reply(`📵 *Anti-Call Status:* ${cfg.anticall ? 'ON' : 'OFF'}\nUsage: *${ctx.prefix}anticall on* | *${ctx.prefix}anticall off*`);
            }
            configStore.updateConfig({ anticall: sub === 'on' });
            await ctx.reply(`✅ *Anti-Call* ab *${sub.toUpperCase()}* hai!${sub === 'on' ? ' Incoming calls auto-reject hongi.' : ''}`);
        }
    },
    {
        name: 'setmenupic',
        aliases: ['setmenuimg', 'setmenudp', 'menupic'],
        category: 'owner',
        desc: 'Reply ki gayi image ko Menu & Profile Card photo lagayein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!media || media.mediaType !== 'image') {
                return ctx.reply(`❌ Kisi image par reply karke *${ctx.prefix}setmenupic* likhein.`);
            }
            setCustomMenuImageBuffer(media.buffer);
            await ctx.reply(`✅ *Menu & Dashboard Card Picture Update Ho Gayi!*\n_${ctx.prefix}menu type karke check karein, ya ${ctx.prefix}resetmenu se default photo wapas lagayein._`);
        }
    },
    {
        name: 'resetmenu',
        aliases: ['resetmenupic', 'defaultmenu'],
        category: 'owner',
        desc: 'Menu Card photo ko wapas SIGMA default photo par reset karein',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return denyNonOwner(ctx);
            const hadCustom = hasCustomMenuImage();
            const ok = resetCustomMenuImageBuffer();
            await ctx.reply(ok
                ? `🔄 *Menu Card Default Photo Par Reset Ho Gayi!*${hadCustom ? ' (Custom image removed)' : ''}`
                : 'ℹ️ Default SIGMA Menu photo active hai.'
            );
        }
    }
];

module.exports = commands;
