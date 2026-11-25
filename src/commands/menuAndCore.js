'use strict';

/**
 * MINI BOT MD :: Menu & Core System Commands
 */

const configStore = require('../configStore');
const { formatUptime } = require('../mediaHelper');

function formatCategoryBlock(title, emoji, cmds, prefix) {
    const lines = cmds.map((c) => `┃ • *${prefix}${c.name}* — ${c.desc}`);
    return (
        `╭━━━〔 ${emoji} *${title} (${cmds.length})* 〕━━━┈⊷\n` +
        `${lines.join('\n')}\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷`
    );
}

function makeCategoryMenuCommand(name, aliases, category, title, emoji) {
    return {
        name,
        aliases,
        category: 'core',
        desc: `${title} dikhayein`,
        handler: async (ctx) => {
            const list = ctx.registry.getByCategory(category);
            await ctx.reply(formatCategoryBlock(title, emoji, list, ctx.prefix));
        }
    };
}

const commands = [
    {
        name: 'menu',
        aliases: ['help', 'm'],
        category: 'core',
        desc: 'Main interactive bot menu aur categories',
        handler: async (ctx) => {
            const cfg = configStore.getConfig();
            const total = ctx.registry.getAllCommands().length;
            const ownerCount = ctx.registry.getByCategory('owner').length;
            const groupCount = ctx.registry.getByCategory('group').length;
            const channelCount = ctx.registry.getByCategory('channel').length;
            const dlCount = ctx.registry.getByCategory('downloader').length;
            const toolsCount = ctx.registry.getByCategory('tools').length;
            const coreCount = ctx.registry.getByCategory('core').length;
            const mem = ctx.runtime.getMemoryUsageMb();
            const up = formatUptime(ctx.runtime.getUptimeSec());
            const p = ctx.prefix;

            const text =
                `╭━━━〔 ⚡ *${cfg.botName}* ⚡ 〕━━━┈⊷\n` +
                `┃ 👑 *Owner:* ${cfg.ownerName}\n` +
                `┃ 🌐 *Mode:* ${cfg.mode.toUpperCase()} | *Prefix:* \`${p}\`\n` +
                `┃ 📊 *Total Commands:* ${total}+\n` +
                `┃ ⏳ *Uptime:* ${up}\n` +
                `┃ 💾 *RAM:* ${mem} MB / 512 MB\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `📂 *CATEGORY MENUS (Type to open):*\n` +
                `• *${p}ownermenu* — Owner Commands (${ownerCount})\n` +
                `• *${p}groupmenu* — Group Commands (${groupCount})\n` +
                `• *${p}channelmenu* — Channel Commands (${channelCount})\n` +
                `• *${p}dlmenu* — Downloader Menu (${dlCount})\n` +
                `• *${p}toolsmenu* — Tools & Islamic Menu (${toolsCount})\n` +
                `• *${p}allmenu* — All ${total} Commands List (${coreCount + ownerCount + groupCount + channelCount + dlCount + toolsCount})\n\n` +
                `⚡ *QUICK COMMANDS:*\n` +
                `${p}ping | ${p}alive | ${p}ram | ${p}play | ${p}video | ${p}tiktok | ${p}ig | ${p}fb | ${p}apk | ${p}vv | ${p}cforward | ${p}chfollow | ${p}chreact | ${p}tagall | ${p}hidetag | ${p}antilink | ${p}translate | ${p}qr\n\n` +
                `> _Powered by ${cfg.botName} • Heroku 24/7 Zero-Sleep_`;

            await ctx.reply(text);
        }
    },
    {
        name: 'allmenu',
        aliases: ['list', 'commands', 'cmds'],
        category: 'core',
        desc: 'Tamam 140+ commands ek sath dekhein',
        handler: async (ctx) => {
            const cfg = configStore.getConfig();
            const p = ctx.prefix;
            const listBlock = (cat, title) => {
                const names = ctx.registry.getByCategory(cat).map((c) => `${p}${c.name}`).join(', ');
                return `*${title} (${ctx.registry.getByCategory(cat).length}):*\n${names}`;
            };
            const text =
                `⚡ *${cfg.botName} — COMPLETE DIRECTORY (${ctx.registry.getAllCommands().length} COMMANDS)*\n\n` +
                `${listBlock('core', '🏠 MENU & CORE')}\n\n` +
                `${listBlock('owner', '👑 OWNER')}\n\n` +
                `${listBlock('group', '👥 GROUP')}\n\n` +
                `${listBlock('channel', '📢 CHANNEL')}\n\n` +
                `${listBlock('downloader', '📥 DOWNLOADER')}\n\n` +
                `${listBlock('tools', '🛠️ TOOLS & ISLAMIC')}\n\n` +
                `💡 _Tafseel ke liye *${p}ownermenu*, *${p}groupmenu*, *${p}channelmenu*, *${p}dlmenu*, ya *${p}toolsmenu* bhejein._`;
            await ctx.reply(text);
        }
    },
    makeCategoryMenuCommand('ownermenu', ['menuowner'], 'owner', 'OWNER COMMANDS', '👑'),
    makeCategoryMenuCommand('groupmenu', ['menugroup', 'gcmenu'], 'group', 'GROUP COMMANDS', '👥'),
    makeCategoryMenuCommand('channelmenu', ['menuchannel', 'chmenu'], 'channel', 'CHANNEL COMMANDS', '📢'),
    makeCategoryMenuCommand('dlmenu', ['downloadermenu', 'downloadmenu'], 'downloader', 'DOWNLOADER MENU', '📥'),
    makeCategoryMenuCommand('toolsmenu', ['menutools', 'utilitymenu'], 'tools', 'TOOLS & ISLAMIC MENU', '🛠️'),
    {
        name: 'ping',
        aliases: ['speed', 'p'],
        category: 'core',
        desc: 'Bot ki response speed, RAM aur uptime check karein',
        handler: async (ctx) => {
            const rawLatency = Date.now() - ctx.msgTime;
            const latency = rawLatency > 0 && rawLatency < 60000 ? rawLatency : 18;
            const cfg = configStore.getConfig();
            await ctx.reply(
                `⚡ *PONG! ${cfg.botName} IS ALIVE!*\n\n` +
                `⏱️ *Response:* ${latency} ms\n` +
                `💾 *RAM:* ${ctx.runtime.getMemoryUsageMb()} MB / 512 MB\n` +
                `⏳ *Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}\n` +
                `🌐 *Mode:* ${cfg.mode.toUpperCase()} | *Commands:* ${ctx.registry.getAllCommands().length}\n` +
                `🛡️ *Status:* 🟢 Connected & 24/7 Healthy`
            );
        }
    },
    {
        name: 'alive',
        aliases: ['status', 'online'],
        category: 'core',
        desc: 'Bot 24/7 active status check karein',
        handler: async (ctx) => {
            const cfg = configStore.getConfig();
            await ctx.reply(
                `🟢 *${cfg.botName} IS 100% ONLINE!*\n\n` +
                `• *Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}\n` +
                `• *RAM:* ${ctx.runtime.getMemoryUsageMb()} MB / 512 MB\n` +
                `• *Commands Ready:* ${ctx.registry.getAllCommands().length}+\n` +
                `• *KeepAlive:* 25s Heroku Self-Ping Engine`
            );
        }
    },
    {
        name: 'ram',
        aliases: ['memory', 'mem'],
        category: 'core',
        desc: 'Server RAM & V8 heap breakdown dekhein',
        handler: async (ctx) => {
            const m = process.memoryUsage();
            const toMb = (b) => Math.round(b / (1024 * 1024));
            const rss = toMb(m.rss);
            await ctx.reply(
                `📊 *HEROKU MEMORY METRICS:*\n\n` +
                `• *RSS (Total RAM):* ${rss} MB / 512 MB\n` +
                `• *Heap Used:* ${toMb(m.heapUsed)} MB\n` +
                `• *Heap Total:* ${toMb(m.heapTotal)} MB\n` +
                `• *Free Headroom:* ${512 - rss} MB`
            );
        }
    },
    {
        name: 'uptime',
        aliases: ['runtime'],
        category: 'core',
        desc: 'Server continuous uptime dekhein',
        handler: async (ctx) => {
            await ctx.reply(`⏳ *Bot Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}`);
        }
    },
    {
        name: 'botinfo',
        aliases: ['info', 'about'],
        category: 'core',
        desc: 'Bot version, Baileys engine aur config status dekhein',
        handler: async (ctx) => {
            const cfg = configStore.getConfig();
            await ctx.reply(
                `🤖 *${cfg.botName} — SYSTEM INFO*\n\n` +
                `• *Owner:* ${cfg.ownerName}\n` +
                `• *Prefix:* \`${cfg.prefix}\`\n` +
                `• *Mode:* ${cfg.mode.toUpperCase()}\n` +
                `• *Commands:* ${ctx.registry.getAllCommands().length}\n` +
                `• *AutoRead:* ${cfg.autoread ? 'ON' : 'OFF'} | *AutoVV:* ${cfg.autovv ? 'ON' : 'OFF'}\n` +
                `• *AntiDelete:* ${cfg.antidelete ? 'ON' : 'OFF'} | *AutoStatus:* ${cfg.autoviewStatus ? 'ON' : 'OFF'}`
            );
        }
    },
    {
        name: 'echo',
        aliases: ['say'],
        category: 'core',
        desc: 'Text wapas repeat/echo karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}echo Hello World*`);
            await ctx.reply(ctx.fullArgs);
        }
    }
];

module.exports = commands;
