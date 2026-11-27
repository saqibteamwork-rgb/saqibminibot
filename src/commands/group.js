'use strict';

/**
 * SIGMA MD :: Group Moderation, Engagement & Settings Commands (32 commands)
 * Includes automatic Group-only, Group-Admin, and Bot-Admin permission guards.
 */

const configStore = require('../configStore');
const {
    extractTargetJid,
    resolveJidToDigits,
    getGroupAdminState,
    extractMedia,
    unwrapMessage,
    getContextInfo,
    getTextFromContent,
    sleep
} = require('../mediaHelper');

async function requireGroupAdmin(ctx, needBotAdmin = true) {
    if (!ctx.isGroup) {
        await ctx.reply('❌ Ye command sirf *Groups* mein chalti hai!');
        return null;
    }
    const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
    const adminState = getGroupAdminState(ctx.sock, meta, ctx.senderRawJid, ctx.senderDigits);
    if (!adminState.isSenderAdmin && !ctx.isOwner) {
        await ctx.reply('🔒 Sirf *Group Admins* ye command use kar sakte hain!');
        return null;
    }
    if (needBotAdmin && !adminState.isBotAdmin) {
        await ctx.reply('⚠️ Pehle *Bot ko Group Admin* banayein taake main ye action kar sakun!');
        return null;
    }
    return { meta, ...adminState };
}

function getAllParticipantJids(meta) {
    return (meta?.participants || []).map((p) => p.id).filter(Boolean);
}

const commands = [
    {
        name: 'groupinfo',
        aliases: ['ginfo', 'gcinfo', 'grpinfo', 'groupdetails'],
        category: 'group',
        desc: 'Group ki mukammal tafseel dekhein',
        handler: async (ctx) => {
            if (!ctx.isGroup) return ctx.reply('❌ Sirf groups mein kaam karta hai!');
            const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
            const admins = meta.participants.filter((p) => p.admin).length;
            const ownerDigits = meta.owner ? meta.owner.split('@')[0].split(':')[0] : 'Unknown';
            const gs = configStore.getGroupSettings(ctx.from);
            await ctx.reply(
                `╭━━━〔 👥 *GROUP INFO* 〕━━━┈⊷\n` +
                `┃ 🏷️ *Name:* ${meta.subject}\n` +
                `┃ 🆔 *JID:* \`${meta.id}\`\n` +
                `┃ 👑 *Creator:* +${ownerDigits}\n` +
                `┃ 👥 *Members:* ${meta.participants.length} (${admins} Admins)\n` +
                `┃ 🔗 *AntiLink:* ${gs.antilink ? 'ON' : 'OFF'}\n` +
                `┃ 👋 *Welcome:* ${gs.welcome ? 'ON' : 'OFF'} | *Goodbye:* ${gs.goodbye ? 'ON' : 'OFF'}\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `📝 *Description:*\n${meta.desc || 'No description'}`
            );
        }
    },
    {
        name: 'grouplink',
        aliases: ['link', 'glink', 'invite', 'linkgc', 'invitelink'],
        category: 'group',
        desc: 'Group ka invite link haasil karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const code = await ctx.sock.groupInviteCode(ctx.from);
            await ctx.reply(`🔗 *Group Invite Link:*\nhttps://chat.whatsapp.com/${code}`);
        }
    },
    {
        name: 'revokelink',
        aliases: ['revoke', 'resetlink'],
        category: 'group',
        desc: 'Group invite link reset karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const code = await ctx.sock.groupRevokeInvite(ctx.from);
            await ctx.reply(`♻️ Purana link cancel ho gaya!\n🔗 *Naya Link:* https://chat.whatsapp.com/${code}`);
        }
    },
    {
        name: 'setgname',
        aliases: ['gname', 'setsubject'],
        category: 'group',
        desc: 'Group ka naam change karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setgname New Group Name*`);
            await ctx.sock.groupUpdateSubject(ctx.from, ctx.fullArgs.slice(0, 100));
            await ctx.reply(`✅ Group name change ho kar *${ctx.fullArgs.slice(0, 100)}* ho gaya!`);
        }
    },
    {
        name: 'setgdesc',
        aliases: ['gdesc', 'setdesc'],
        category: 'group',
        desc: 'Group description update karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setgdesc <new description>*`);
            await ctx.sock.groupUpdateDescription(ctx.from, ctx.fullArgs);
            await ctx.reply('✅ Group description update ho gayi!');
        }
    },
    {
        name: 'setgpp',
        aliases: ['setgrouppp', 'setgrouppfp', 'gpp', 'groupdp', 'gcdp'],
        category: 'group',
        desc: 'Reply ki gayi photo ko group icon lagayein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!media || media.mediaType !== 'image') return ctx.reply('❌ Kisi image par reply karke `.setgpp` chalayein.');
            await ctx.sock.updateProfilePicture(ctx.from, media.buffer);
            await ctx.reply('✅ Group icon change ho gaya!');
        }
    },
    {
        name: 'lock',
        aliases: ['close', 'mute', 'glock', 'gclose', 'lockgroup', 'lockgc'],
        category: 'group',
        desc: 'Group chat band karein (Only Admins)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            await ctx.sock.groupSettingUpdate(ctx.from, 'announcement');
            await ctx.reply('🔒 *Group Band Kar Diya Gaya!* Ab sirf Admins message kar sakte hain.');
        }
    },
    {
        name: 'unlock',
        aliases: ['open', 'unmute', 'gunlock', 'gopen', 'unlockgroup', 'unlockgc'],
        category: 'group',
        desc: 'Group chat kholein (All Members)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            await ctx.sock.groupSettingUpdate(ctx.from, 'not_announcement');
            await ctx.reply('🔓 *Group Khol Diya Gaya!* Ab sab members message kar sakte hain.');
        }
    },
    {
        name: 'locksettings',
        aliases: ['lockinfo'],
        category: 'group',
        desc: 'Sirf admins group info edit kar sakein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            await ctx.sock.groupSettingUpdate(ctx.from, 'locked');
            await ctx.reply('🔐 Ab sirf Group Admins naam/icon/description edit kar sakte hain.');
        }
    },
    {
        name: 'unlocksettings',
        aliases: ['unlockinfo'],
        category: 'group',
        desc: 'Sab members group info edit kar sakein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            await ctx.sock.groupSettingUpdate(ctx.from, 'unlocked');
            await ctx.reply('🔓 Ab sab members group info edit kar sakte hain.');
        }
    },
    {
        name: 'add',
        aliases: ['addmember', 'inviteuser'],
        category: 'group',
        desc: 'Number se member group mein add karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const digits = (ctx.args[0] || '').replace(/[^0-9]/g, '');
            if (digits.length < 8) return ctx.reply(`Usage: *${ctx.prefix}add 923001234567*`);
            const jid = `${digits}@s.whatsapp.net`;
            await ctx.sock.groupParticipantsUpdate(ctx.from, [jid], 'add');
            await ctx.reply(`➕ *+${digits}* ko group mein add karne ki request bhej di gayi.`);
        }
    },
    {
        name: 'kick',
        aliases: ['remove', 'out', 'k', 'kickuser', 'kickmember'],
        category: 'group',
        desc: 'Member ko group se remove karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, st.meta);
            if (!target) return ctx.reply(`Usage: Kisi ko mention ya reply karke *${ctx.prefix}kick* chalayein.`);
            await ctx.sock.groupParticipantsUpdate(ctx.from, [target], 'remove');
            await ctx.sock.sendMessage(ctx.from, { text: `🥾 @${target.split('@')[0]} ko group se remove kar diya gaya.`, mentions: [target] }, ctx.quoteOpt);
        }
    },
    {
        name: 'promote',
        aliases: ['admin', 'makeadmin', 'giveadmin', 'permote', 'prom'],
        category: 'group',
        desc: 'Member ko Group Admin banayein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, st.meta);
            if (!target) return ctx.reply(`Usage: *${ctx.prefix}promote @user*`);
            await ctx.sock.groupParticipantsUpdate(ctx.from, [target], 'promote');
            await ctx.sock.sendMessage(ctx.from, { text: `👑 @${target.split('@')[0]} ab *Group Admin* ban gaye!`, mentions: [target] }, ctx.quoteOpt);
        }
    },
    {
        name: 'demote',
        aliases: ['unadmin', 'd', 'dismiss', 'removeadmin', 'dem'],
        category: 'group',
        desc: 'Group Admin ko normal member karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, st.meta);
            if (!target) return ctx.reply(`Usage: *${ctx.prefix}demote @user*`);
            await ctx.sock.groupParticipantsUpdate(ctx.from, [target], 'demote');
            await ctx.sock.sendMessage(ctx.from, { text: `⬇️ @${target.split('@')[0]} ko Admin position se hata diya gaya.`, mentions: [target] }, ctx.quoteOpt);
        }
    },
    {
        name: 'promoteall',
        aliases: [],
        category: 'group',
        desc: 'Sab non-admin members ko admin banayein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const targets = st.participants.filter((p) => !p.admin).map((p) => p.id);
            if (!targets.length) return ctx.reply('ℹ️ Sab members pehle se Admin hain.');
            await ctx.sock.groupParticipantsUpdate(ctx.from, targets, 'promote');
            await ctx.reply(`👑 *${targets.length}* members ko Group Admin bana diya gaya!`);
        }
    },
    {
        name: 'demoteall',
        aliases: [],
        category: 'group',
        desc: 'Bot aur Creator ke ilawa sab admins ko demote karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const botDigits = configStore.normalizeDigits(ctx.sock.user?.id);
            const targets = st.participants
                .filter((p) => p.admin === 'admin' && configStore.normalizeDigits(p.phoneNumber || p.id) !== botDigits)
                .map((p) => p.id);
            if (!targets.length) return ctx.reply('ℹ️ Koi aur admin demote karne ke liye nahi mila.');
            await ctx.sock.groupParticipantsUpdate(ctx.from, targets, 'demote');
            await ctx.reply(`⬇️ *${targets.length}* admins ko demote kar diya gaya.`);
        }
    },
    {
        name: 'tagall',
        aliases: ['everyone', 'all', 'mentionall', 'tagmembers'],
        category: 'group',
        desc: 'Group ke sab members ko tag karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            const mentions = getAllParticipantJids(st.meta);
            const note = ctx.fullArgs || 'Sab members hazir hon!';
            const body = mentions.map((j, i) => `${i + 1}. @${j.split('@')[0]}`).join('\n');
            await ctx.sock.sendMessage(ctx.from, {
                text: `📢 *TAG ALL (${mentions.length})*\n📝 *Message:* ${note}\n\n${body}`,
                mentions
            }, ctx.quoteOpt);
        }
    },
    {
        name: 'hidetag',
        aliases: ['ht', 'tag', 'h', 'silenttag'],
        category: 'group',
        desc: 'Silent mention (bina IDs dikhaye sab ko tag)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            const mentions = getAllParticipantJids(st.meta);
            const qText = ctx.quotedMsg ? getTextFromContent(unwrapMessage(ctx.quotedMsg)) : '';
            const text = ctx.fullArgs || qText || '📢 Attention Everyone!';
            await ctx.sock.sendMessage(ctx.from, { text, mentions });
        }
    },
    {
        name: 'tagadmins',
        aliases: ['admins'],
        category: 'group',
        desc: 'Sirf group admins ko mention karein',
        handler: async (ctx) => {
            if (!ctx.isGroup) return ctx.reply('❌ Sirf groups mein kaam karta hai!');
            const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
            const admins = meta.participants.filter((p) => p.admin).map((p) => p.id);
            const note = ctx.fullArgs || 'Group Admins please check!';
            await ctx.sock.sendMessage(ctx.from, {
                text: `🛡️ *TAG ADMINS (${admins.length})*\n${note}\n\n` + admins.map((j) => `• @${j.split('@')[0]}`).join('\n'),
                mentions: admins
            }, ctx.quoteOpt);
        }
    },
    {
        name: 'listadmins',
        aliases: ['adminlist'],
        category: 'group',
        desc: 'Bina ping kiye admins ki list dikhayein',
        handler: async (ctx) => {
            if (!ctx.isGroup) return ctx.reply('❌ Sirf groups mein kaam karta hai!');
            const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
            const admins = meta.participants.filter((p) => p.admin);
            await ctx.reply(
                `👑 *GROUP ADMINS (${admins.length}):*\n\n` +
                admins.map((a, i) => `${i + 1}. +${a.phoneNumber ? a.phoneNumber.split('@')[0] : a.id.split('@')[0]} (${a.admin})`).join('\n')
            );
        }
    },
    {
        name: 'membercount',
        aliases: ['totalmembers'],
        category: 'group',
        desc: 'Group mein total members aur admins count',
        handler: async (ctx) => {
            if (!ctx.isGroup) return ctx.reply('❌ Sirf groups mein kaam karta hai!');
            const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
            const admins = meta.participants.filter((p) => p.admin).length;
            await ctx.reply(`👥 *${meta.subject}*\n• Total Members: *${meta.participants.length}*\n• Admins: *${admins}*\n• Normal Members: *${meta.participants.length - admins}*`);
        }
    },
    {
        name: 'del',
        aliases: ['delete'],
        category: 'group',
        desc: 'Quoted message sab ke liye delete karein',
        handler: async (ctx) => {
            const unwrapped = unwrapMessage(ctx.msg.message);
            const mCtx = getContextInfo(unwrapped);
            if (!mCtx?.stanzaId) return ctx.reply('❌ Jis message ko delete karna hai uspar reply karein.');
            if (ctx.isGroup) {
                const st = await requireGroupAdmin(ctx, true);
                if (!st) return;
            } else if (!ctx.isOwner) {
                return;
            }
            const delKey = {
                remoteJid: ctx.from,
                fromMe: Boolean(mCtx.participant && configStore.normalizeDigits(mCtx.participant) === configStore.normalizeDigits(ctx.sock.user?.id)),
                id: mCtx.stanzaId,
                ...(ctx.isGroup && mCtx.participant ? { participant: mCtx.participant } : {})
            };
            await ctx.sock.sendMessage(ctx.from, { delete: delKey });
        }
    },
    {
        name: 'join',
        aliases: ['joingc', 'joincommunity', 'joingroup'],
        category: 'group',
        desc: 'Invite link se Group ya Community join karein (Owner)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return ctx.reply('🔒 Sirf Bot Owner `.joingc` chala sakta hai.');
            const raw = (ctx.fullArgs || '').trim();
            const m = raw.match(/(?:chat\.whatsapp\.com\/|invite\/)([0-9A-Za-z_-]{18,32})/i) || (raw.match(/^[0-9A-Za-z_-]{18,32}$/) ? [raw, raw] : null);
            if (!m) return ctx.reply(`Usage: *${ctx.prefix}joingc https://chat.whatsapp.com/xxxxx* *(Group ya Community)*`);
            const code = m[1];
            const info = typeof ctx.sock.groupGetInviteInfo === 'function' ? await ctx.sock.groupGetInviteInfo(code).catch(() => null) : null;
            const typeLabel = (info?.isCommunity || info?.isCommunityAnnounce || info?.linkedParent) ? '🏘️ Community' : '👥 Group';
            const title = info?.subject || 'WhatsApp Group / Community';
            try {
                const gid = await ctx.sock.groupAcceptInvite(code);
                if (!gid) {
                    return ctx.reply(`📨 *Join Request Bhej Di Gayi Hai!*\n• *Type:* ${typeLabel}\n• *Name:* ${title}`);
                }
                await ctx.reply(`✅ *${typeLabel} Join Ho Gaya!*\n• *Name:* ${title}\n• 🆔 \`${gid}\``);
            } catch (e) {
                const msgStr = String(e.message || '');
                if (/request|approval|401|403/i.test(msgStr)) {
                    return ctx.reply(`📨 *Join Request Bhej Di Gayi Hai!* Admin approval ke baad join ho jayenge.`);
                }
                if (/409|already/i.test(msgStr)) {
                    return ctx.reply(`ℹ️ Bot pehle se is Group / Community mein shamil hai!`);
                }
                throw e;
            }
        }
    },
    {
        name: 'gcautojoin',
        aliases: ['ajg', 'autojoingc', 'setajg', 'delajg', 'ajglist'],
        category: 'group',
        desc: 'Bot connect par Auto-Join Group/Community list manage karein (add/del/list/run/off)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!(ctx.isMasterOwner ?? (!ctx.tenantConfig?.creatorId && ctx.isOwner))) {
                return ctx.reply('🔒 Sirf Platform Master Owner global auto-join list manage kar sakta hai.');
            }
            const cfg = configStore.getConfig();
            const list = [...(cfg.autoJoinGroups || [])];
            const rawArgs = ctx.args || [];
            const cmdLower = (ctx.commandName || '').toLowerCase();
            let sub = (rawArgs[0] || '').toLowerCase();
            if (cmdLower === 'delajg') sub = rawArgs.length ? 'del' : 'off';

            if (sub === 'off' || sub === 'clear') {
                configStore.updateConfig({ autoJoinGroups: [] });
                return ctx.reply('🗑️ Auto-Join Group/Community list clear aur disable ho gayi.');
            }
            if (sub === 'del' || sub === 'rm') {
                const target = (cmdLower === 'delajg' ? rawArgs.join(' ') : rawArgs.slice(1).join(' ')).trim();
                const idx = /^\d+$/.test(target) ? parseInt(target, 10) - 1 : -1;
                let updated = list;
                if (idx >= 0 && idx < list.length) updated = list.filter((_, i) => i !== idx);
                else if (target) updated = list.filter((g) => !g.code.includes(target) && !g.link.includes(target));
                configStore.updateConfig({ autoJoinGroups: updated });
                return ctx.reply(`🗑️ Auto-Join list updated (*${updated.length}* remaining).`);
            }
            if (sub === 'run') {
                let done = 0;
                for (const g of list) {
                    try {
                        await ctx.sock.groupAcceptInvite(g.code);
                        done++;
                        await sleep(800);
                    } catch (_) {}
                }
                return ctx.reply(`⚡ Auto-Join run completed: *${done}/${list.length}* joined.`);
            }

            const linkCand = (sub === 'add' ? rawArgs.slice(1) : rawArgs).join(' ').trim();
            const m = linkCand.match(/(?:chat\.whatsapp\.com\/|invite\/)([0-9A-Za-z_-]{18,32})/i) || (linkCand.match(/^[0-9A-Za-z_-]{18,32}$/) ? [linkCand, linkCand] : null);
            if (m && sub !== 'list') {
                const code = m[1];
                const info = typeof ctx.sock.groupGetInviteInfo === 'function' ? await ctx.sock.groupGetInviteInfo(code).catch(() => null) : null;
                const isCommunity = Boolean(info?.isCommunity || info?.isCommunityAnnounce || info?.linkedParent);
                const name = info?.subject || 'WhatsApp Group / Community';
                if (!list.some((x) => x.code === code)) {
                    list.push({ code, link: `https://chat.whatsapp.com/${code}`, name, isCommunity });
                    configStore.updateConfig({ autoJoinGroups: list });
                }
                await ctx.sock.groupAcceptInvite(code).catch(() => {});
                return ctx.reply(`✅ *${name}* (${isCommunity ? '🏘️ Community' : '👥 Group'}) Auto-Join list mein add aur join ho gaya!`);
            }

            if (!list.length) {
                return ctx.reply(`ℹ️ Auto-Join Group/Community list khali hai.\nAdd: *${ctx.prefix}gcautojoin <link>* ya *${ctx.prefix}ajg <link>*`);
            }
            await ctx.reply(
                `📌 *AUTO-JOIN GROUPS & COMMUNITIES (${list.length}):*\n\n` +
                list.map((g, i) => `${i + 1}. ${g.isCommunity ? '🏘️' : '👥'} *${g.name}*\n   ${g.link}`).join('\n') +
                `\n\nCommands: \`add <link>\` | \`del 1\` | \`run\` | \`off\``
            );
        }
    },
    {
        name: 'leave',
        aliases: ['left', 'bye'],
        category: 'group',
        desc: 'Bot ko is group se leave karwayein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            await ctx.reply('👋 Allah Hafiz! Bot group chhod raha hai...');
            await sleep(800);
            await ctx.sock.groupLeave(ctx.from);
        }
    },
    {
        name: 'creategroup',
        aliases: ['newgc'],
        category: 'group',
        desc: 'Naya WhatsApp group banayein (Owner)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return ctx.reply('🔒 Sirf Bot Owner naya group bana sakta hai.');
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}creategroup My Awesome Group*`);
            const gc = await ctx.sock.groupCreate(ctx.fullArgs.slice(0, 80), []);
            const code = await ctx.sock.groupInviteCode(gc.id).catch(() => null);
            await ctx.reply(`✅ Naya Group ban gaya!\n🏷️ *Name:* ${gc.subject}\n🆔 \`${gc.id}\`${code ? `\n🔗 https://chat.whatsapp.com/${code}` : ''}`);
        }
    },
    {
        name: 'requests',
        aliases: ['pending'],
        category: 'group',
        desc: 'Group mein pending join requests dekhein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const list = await ctx.sock.groupRequestParticipantsList(ctx.from).catch(() => []);
            if (!list.length) return ctx.reply('ℹ️ Koi pending join request nahi hai.');
            await ctx.reply(`📥 *PENDING JOIN REQUESTS (${list.length}):*\n\n` + list.map((r, i) => `${i + 1}. +${r.jid.split('@')[0]}`).join('\n'));
        }
    },
    {
        name: 'accept',
        aliases: ['approve'],
        category: 'group',
        desc: 'Specific ya pehli join request approve karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const list = await ctx.sock.groupRequestParticipantsList(ctx.from).catch(() => []);
            if (!list.length) return ctx.reply('ℹ️ Koi pending request nahi mili.');
            const num = (ctx.args[0] || '').replace(/[^0-9]/g, '');
            const found = (num && list.find((r) => r.jid.includes(num))) || list[0];
            await ctx.sock.groupRequestParticipantsUpdate(ctx.from, [found.jid], 'approve');
            await ctx.reply(`✅ Request approve ho gayi: +${found.jid.split('@')[0]}`);
        }
    },
    {
        name: 'acceptall',
        aliases: ['approveall'],
        category: 'group',
        desc: 'Tamam pending join requests approve karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const list = await ctx.sock.groupRequestParticipantsList(ctx.from).catch(() => []);
            if (!list.length) return ctx.reply('ℹ️ Koi pending request nahi.');
            await ctx.sock.groupRequestParticipantsUpdate(ctx.from, list.map((r) => r.jid), 'approve');
            await ctx.reply(`✅ Tamam *${list.length}* join requests approve kar di gayin!`);
        }
    },
    {
        name: 'reject',
        aliases: ['decline'],
        category: 'group',
        desc: 'Specific join request reject karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const list = await ctx.sock.groupRequestParticipantsList(ctx.from).catch(() => []);
            if (!list.length) return ctx.reply('ℹ️ Koi pending request nahi mili.');
            const num = (ctx.args[0] || '').replace(/[^0-9]/g, '');
            const found = (num && list.find((r) => r.jid.includes(num))) || list[0];
            await ctx.sock.groupRequestParticipantsUpdate(ctx.from, [found.jid], 'reject');
            await ctx.reply(`❌ Request reject kar di gayi: +${found.jid.split('@')[0]}`);
        }
    },
    {
        name: 'rejectall',
        aliases: ['declineall'],
        category: 'group',
        desc: 'Tamam pending join requests reject karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const list = await ctx.sock.groupRequestParticipantsList(ctx.from).catch(() => []);
            if (!list.length) return ctx.reply('ℹ️ Koi pending request nahi.');
            await ctx.sock.groupRequestParticipantsUpdate(ctx.from, list.map((r) => r.jid), 'reject');
            await ctx.reply(`🗑️ Tamam *${list.length}* join requests reject kar di gayin.`);
        }
    },
    {
        name: 'antilink',
        aliases: ['al', 'linkblock', 'blocklink'],
        category: 'group',
        desc: 'Group mein links auto-delete & warn toggle (on/off)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const sub = (ctx.args[0] || '').toLowerCase();
            const gs = configStore.getGroupSettings(ctx.from);
            if (!['on', 'off'].includes(sub)) return ctx.reply(`🔗 *Anti-Link:* ${gs.antilink ? 'ON' : 'OFF'}\nUsage: *${ctx.prefix}antilink on* / *off*`);
            configStore.updateGroupSettings(ctx.from, { antilink: sub === 'on' });
            await ctx.reply(`✅ Group Anti-Link ab *${sub.toUpperCase()}* ho gaya!`);
        }
    },
    {
        name: 'welcome',
        aliases: ['wlc', 'wlcm'],
        category: 'group',
        desc: 'Naye members ke liye welcome message on/off',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            const sub = (ctx.args[0] || '').toLowerCase();
            const gs = configStore.getGroupSettings(ctx.from);
            if (!['on', 'off'].includes(sub)) return ctx.reply(`👋 *Welcome:* ${gs.welcome ? 'ON' : 'OFF'}\nUsage: *${ctx.prefix}welcome on* / *off*`);
            configStore.updateGroupSettings(ctx.from, { welcome: sub === 'on' });
            await ctx.reply(`✅ Group Welcome ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'goodbye',
        aliases: ['gbye', 'byemsg'],
        category: 'group',
        desc: 'Group chhodne walon ke liye goodbye message on/off',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            const sub = (ctx.args[0] || '').toLowerCase();
            const gs = configStore.getGroupSettings(ctx.from);
            if (!['on', 'off'].includes(sub)) return ctx.reply(`👋 *Goodbye:* ${gs.goodbye ? 'ON' : 'OFF'}\nUsage: *${ctx.prefix}goodbye on* / *off*`);
            configStore.updateGroupSettings(ctx.from, { goodbye: sub === 'on' });
            await ctx.reply(`✅ Group Goodbye ab *${sub.toUpperCase()}* hai.`);
        }
    },
    {
        name: 'setwelcome',
        aliases: [],
        category: 'group',
        desc: 'Custom welcome message set karein (@user & @group tags)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setwelcome Khush Amdeed @user in @group!*`);
            configStore.updateGroupSettings(ctx.from, { welcome: true, welcomeText: ctx.fullArgs });
            await ctx.reply('✅ Custom Welcome message save + ON ho gaya!');
        }
    },
    {
        name: 'setgoodbye',
        aliases: [],
        category: 'group',
        desc: 'Custom goodbye message set karein (@user & @group tags)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}setgoodbye Allah Hafiz @user!*`);
            configStore.updateGroupSettings(ctx.from, { goodbye: true, goodbyeText: ctx.fullArgs });
            await ctx.reply('✅ Custom Goodbye message save + ON ho gaya!');
        }
    },
    {
        name: 'poll',
        aliases: ['createpoll', 'mkpoll'],
        category: 'group',
        desc: 'WhatsApp poll banayein (.poll Sawaal | Opt1 | Opt2)',
        handler: async (ctx) => {
            const parts = (ctx.fullArgs || '').split('|').map((s) => s.trim()).filter(Boolean);
            if (parts.length < 3) {
                return ctx.reply(`Usage: *${ctx.prefix}poll Best Language? | JavaScript | Python | Go*`);
            }
            const [name, ...values] = parts;
            await ctx.sock.sendMessage(ctx.from, {
                poll: { name, values: values.slice(0, 12), selectableCount: 1 }
            });
        }
    },
    {
        name: 'warn',
        aliases: ['wrn', 'warning'],
        category: 'group',
        desc: 'Member ko warning dein (3 warns par kick)',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, true);
            if (!st) return;
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, st.meta);
            if (!target) return ctx.reply(`Usage: *${ctx.prefix}warn @user*`);
            const unwrapped = unwrapMessage(ctx.msg.message);
            const digits = await resolveJidToDigits(ctx.sock, target, getContextInfo(unwrapped)?.participantAlt, st.meta);
            const count = configStore.addWarning(ctx.from, digits);
            if (count >= 3) {
                configStore.resetWarnings(ctx.from, digits);
                await ctx.sock.groupParticipantsUpdate(ctx.from, [target], 'remove').catch(() => {});
                return await ctx.sock.sendMessage(ctx.from, {
                    text: `🚨 @${target.split('@')[0]} ke *3/3 warnings* complete ho gaye! Group se remove kar diya gaya.`,
                    mentions: [target]
                }, ctx.quoteOpt);
            }
            await ctx.sock.sendMessage(ctx.from, {
                text: `⚠️ @${target.split('@')[0]} ko warning di gayi! (*${count}/3*)`,
                mentions: [target]
            }, ctx.quoteOpt);
        }
    },
    {
        name: 'resetwarn',
        aliases: ['unwarn', 'rmwarn', 'delwarn', 'clearwarn'],
        category: 'group',
        desc: 'Member ki warnings reset karein',
        handler: async (ctx) => {
            const st = await requireGroupAdmin(ctx, false);
            if (!st) return;
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, st.meta);
            if (!target) return ctx.reply(`Usage: *${ctx.prefix}resetwarn @user*`);
            const digits = await resolveJidToDigits(ctx.sock, target, null, st.meta);
            configStore.resetWarnings(ctx.from, digits);
            await ctx.sock.sendMessage(ctx.from, { text: `✅ @${target.split('@')[0]} ki warnings clear ho gayin.`, mentions: [target] }, ctx.quoteOpt);
        }
    },
    {
        name: 'randommember',
        aliases: ['pick', 'lucky'],
        category: 'group',
        desc: 'Group mein se random member select karein',
        handler: async (ctx) => {
            if (!ctx.isGroup) return ctx.reply('❌ Sirf groups mein kaam karta hai!');
            const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
            const list = meta.participants;
            const pick = list[Math.floor(Math.random() * list.length)];
            await ctx.sock.sendMessage(ctx.from, {
                text: `🎲 *Lucky Winner:* @${pick.id.split('@')[0]}`,
                mentions: [pick.id]
            }, ctx.quoteOpt);
        }
    },
    {
        name: 'vcf',
        aliases: ['contacts', 'exportcontacts', 'groupvcf'],
        category: 'group',
        desc: 'Group ke tamam members ka .vcf Contacts card export karein',
        handler: async (ctx) => {
            if (!ctx.isGroup) return ctx.reply('❌ Yeh command sirf *Groups* mein chalti hai!');
            ctx.react('📇');
            const meta = ctx.groupMeta || await ctx.sock.groupMetadata(ctx.from);
            const participants = meta?.participants || [];
            let vcfData = '';
            let exported = 0;

            for (let i = 0; i < participants.length; i++) {
                const p = participants[i];
                const digits = await resolveJidToDigits(ctx.sock, p.id, p.phoneNumber || p.pn || null, meta);
                const clean = String(digits || '').replace(/[^0-9]/g, '');
                if (clean.length >= 7 && clean.length <= 15) {
                    exported++;
                    vcfData += `BEGIN:VCARD\nVERSION:3.0\nFN:${meta.subject || 'Group'} Member ${exported}\nTEL;type=CELL;type=VOICE;waid=${clean}:+${clean}\nEND:VCARD\n`;
                }
            }

            if (!exported) return ctx.reply('❌ Group members ke valid phone numbers nahi mil sake.');
            const cleanName = (meta.subject || 'Group_Contacts').replace(/[^a-zA-Z0-9_-]/g, '_');
            await ctx.sock.sendMessage(ctx.from, {
                document: Buffer.from(vcfData, 'utf8'),
                mimetype: 'text/vcard',
                fileName: `${cleanName}_Contacts.vcf`,
                caption: `📇 *GROUP VCF EXPORTER*\n• *Group:* ${meta.subject}\n• *Contacts Exported:* ${exported}/${participants.length}`
            }, ctx.quoteOpt);
        }
    }
];

module.exports = commands;
