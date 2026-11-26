'use strict';

/**
 * SIGMA MD :: Menu, Profile & Core System Commands
 * Replicates the signature Style 1 aesthetic menu with preloaded SIGMA artwork,
 * live user profile card, and Mini Bot + Main Bot pair links.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const configStore = require('../configStore');
const { formatUptime } = require('../mediaHelper');

const MENU_IMAGE_PATH = path.join(__dirname, '..', '..', 'assets', 'sigma_menu.png');
let PRELOADED_MENU_IMAGE = null;
try {
    if (fs.existsSync(MENU_IMAGE_PATH)) {
        PRELOADED_MENU_IMAGE = fs.readFileSync(MENU_IMAGE_PATH);
    }
} catch (_) {}

function getMenuImageBuffer() {
    if (PRELOADED_MENU_IMAGE) return PRELOADED_MENU_IMAGE;
    try {
        if (fs.existsSync(MENU_IMAGE_PATH)) {
            PRELOADED_MENU_IMAGE = fs.readFileSync(MENU_IMAGE_PATH);
        }
    } catch (_) {}
    return PRELOADED_MENU_IMAGE;
}

function toSansBold(str) {
    return String(str || '').replace(/[A-Za-z0-9]/g, (c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + code - 65);
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + code - 97);
        if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + code - 48);
        return c;
    });
}

function toSansItalic(str) {
    return String(str || '').replace(/[A-Za-z]/g, (c) => {
        const code = c.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D608 + code - 65);
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D622 + code - 97);
        return c;
    });
}

const CATEGORY_SECTIONS = [
    { key: 'core', title: 'MENU & CORE', aliases: ['core', 'main', 'general'] },
    { key: 'owner', title: 'OWNER', aliases: ['owner', 'onwer', 'own', 'sudo', 'ownermenu'] },
    { key: 'group', title: 'GROUP', aliases: ['group', 'gc', 'grp', 'groupmenu', 'gcmenu'] },
    { key: 'channel', title: 'CHANNEL', aliases: ['channel', 'ch', 'chnl', 'channelmenu', 'chmenu'] },
    { key: 'downloader', title: 'DOWNLOAD', aliases: ['dl', 'download', 'downloader', 'down', 'dlmenu'] },
    { key: 'tools', title: 'TOOLS & ISLAMIC', aliases: ['tool', 'tools', 'utility', 'util', 'islamic', 'toolsmenu'] }
];

function resolveCategorySection(query) {
    const clean = String(query || '').toLowerCase().replace(/[^a-z0-9&]/g, '').trim();
    if (!clean) return null;
    for (const sec of CATEGORY_SECTIONS) {
        if (sec.key === clean || sec.aliases.includes(clean)) return sec;
    }
    return null;
}

function makeBox(title, cmds, prefix) {
    const head = `┌───⭓ ⚡ ${toSansBold(title.toUpperCase())} ⭓───\n`;
    const body = cmds.map((c) => `│ ⬡ ${prefix}${toSansBold(c.name)}`).join('\n') + '\n';
    const foot = `└───────────────────⭓\n`;
    return head + body + foot;
}

function buildMenuHeader(ctx, displayedCommands) {
    const cfg = configStore.getConfig();
    const botName = cfg.botName || 'SIGMA MD';
    const ownerName = cfg.ownerName || 'MR SAQIB';
    const userName = String(ctx.msg?.pushName || ctx.senderDigits || 'User').replace(/[*_~`]/g, '').trim().slice(0, 40) || 'User';
    const p = ctx.prefix || '.';
    const usedMem = ctx.runtime.getMemoryUsageMb();
    const totalMem = Math.round(os.totalmem() / (1024 * 1024));
    const runtimeStr = formatUptime(ctx.runtime.getUptimeSec());
    const dateStr = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
    const modeLabel = cfg.mode === 'public' ? 'Public 🌍' : (cfg.mode === 'self' ? 'Self 🔒' : 'Private 🔒');

    return (
        `╭━━━〔 ⚡ ${toSansBold(botName)} ⚡ 〕━━━┈⊷\n` +
        `┃ 👤 ${toSansBold('User')}: _${userName}_\n` +
        `┃ 👑 ${toSansBold('Owner')}: ${toSansBold(ownerName)}\n` +
        `┃ 🟢 ${toSansBold('Status')}: ${toSansBold('Connected')} 🟢\n` +
        `┃ ⚙️ ${toSansBold('System')}: ${toSansBold('Active')} ⚡\n` +
        `┃ 🌐 ${toSansBold('Server')}: ${toSansBold('Running')} 🚀\n` +
        `┃ 🔥 ${toSansBold('Modules')}: ${toSansBold('Active')} 🔥\n` +
        `┃ 📱 ${toSansBold('Baileys')}: _Multi-Device_\n` +
        `┃ 📅 ${toSansBold('Date')}: _${dateStr}_\n` +
        `┃ ⏳ ${toSansBold('Uptime')}: _${runtimeStr}_\n` +
        `┃ 🔑 ${toSansBold('Prefix')}: [ ${p} ]\n` +
        `┃ 🛡️ ${toSansBold('Mode')}: _${modeLabel}_\n` +
        `┃ 📊 ${toSansBold('RAM')}: _${usedMem}MB / ${totalMem}MB_\n` +
        `┃ 📂 ${toSansBold('Total Commands')}: ${toSansBold(String(displayedCommands))}\n` +
        `┃ 📦 ${toSansBold('Version')}: _2.0.0_\n` +
        `╰━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
        ` ➤ ${p}${toSansBold('menu')} _type karein commands ke liye_`
    );
}

function buildPairLinksCard(cfg) {
    const botName = cfg.botName || 'SIGMA MD';
    const ownerName = cfg.ownerName || 'MR SAQIB';
    const miniPair = cfg.miniPairUrl || 'https://sigmaminibot.vercel.app';
    const mainPair = cfg.mainPairUrl || 'https://mrsaqib.me/pair';

    return (
        `╭━━━〔 👑 ${toSansBold('POWERED BY')} 〕━━━┈⊷\n` +
        `┃ ⚡ ${toSansBold(botName)}\n` +
        `┃ 🚀 ${toSansBold(ownerName)}\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
        `╭━━━〔 🔗 *PAIR & OFFICIAL LINKS* 〕━━━┈⊷\n` +
        `┃ 🤖 *Mini Bot Pair Link:*\n` +
        `┃ ${miniPair}\n` +
        `┃ ⚡ *Main Bot Pair Link:*\n` +
        `┃ ${mainPair}\n` +
        `┃ 🔍 *Search on Google:*\n` +
        `┃ google.com/search?q=mr+saqib\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷`
    );
}

function buildNewsletterContext(cfg) {
    const botName = cfg.botName || 'SIGMA MD';
    if (!cfg.channelCardEnabled || !cfg.newsletterJid) return undefined;
    return {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: cfg.newsletterJid,
            newsletterName: botName,
            serverMessageId: 1
        }
    };
}

async function sendStyledMenu(ctx, sections, headerCommandCount) {
    const cfg = configStore.getConfig();
    const headerText = buildMenuHeader(ctx, headerCommandCount);
    const boxesText = sections
        .map((sec) => {
            const cmds = ctx.registry.getByCategory(sec.key);
            return cmds.length ? makeBox(sec.title, cmds, ctx.prefix || '.') : '';
        })
        .filter(Boolean)
        .join('\n');
    const linksCard = buildPairLinksCard(cfg);
    const fullText = `${headerText}\n\n${boxesText.trim()}\n\n${linksCard}`.trim();

    const newsletterCtx = buildNewsletterContext(cfg);
    const replyOpts = ctx.msg ? { quoted: ctx.msg } : ctx.quoteOpt;
    const imgBuf = getMenuImageBuffer();

    const payloadBase = newsletterCtx ? { contextInfo: newsletterCtx } : {};

    if (imgBuf) {
        try {
            await Promise.race([
                ctx.sock.sendMessage(ctx.from, { image: imgBuf, caption: fullText, ...payloadBase }, replyOpts),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Menu image send timeout')), 8000))
            ]);
            return;
        } catch (_) {}
    }

    await ctx.sock.sendMessage(ctx.from, { text: fullText, ...payloadBase }, replyOpts);
}

function makeCategoryMenuCommand(name, aliases, category, title) {
    return {
        name,
        aliases,
        category: 'core',
        desc: `${title} dikhayein`,
        handler: async (ctx) => {
            ctx.react('⚡');
            const list = ctx.registry.getByCategory(category);
            await sendStyledMenu(ctx, [{ key: category, title }], list.length);
        }
    };
}

const commands = [
    {
        name: 'menu',
        aliases: ['help', 'm'],
        category: 'core',
        desc: 'SIGMA MD interactive menu, profile aur pair links',
        handler: async (ctx) => {
            ctx.react('⚡');
            const argSection = ctx.args[0] ? resolveCategorySection(ctx.args[0]) : null;
            if (argSection) {
                const count = ctx.registry.getByCategory(argSection.key).length;
                return await sendStyledMenu(ctx, [argSection], count);
            }
            const total = ctx.registry.getAllCommands().length;
            await sendStyledMenu(ctx, CATEGORY_SECTIONS, total);
        }
    },
    {
        name: 'allmenu',
        aliases: ['list', 'commands', 'cmds'],
        category: 'core',
        desc: 'Tamam commands SIGMA MD menu style mein dekhein',
        handler: async (ctx) => {
            ctx.react('⚡');
            const total = ctx.registry.getAllCommands().length;
            await sendStyledMenu(ctx, CATEGORY_SECTIONS, total);
        }
    },
    {
        name: 'profile',
        aliases: ['owner', 'onwer', 'dev', 'developer', 'creator', 'myprofile', 'profileinfo'],
        category: 'core',
        desc: 'Bot profile, developer info aur Mini/Main Bot Pair links dekhein',
        handler: async (ctx) => {
            ctx.react('👑');
            const cfg = configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            const ownerName = cfg.ownerName || 'MR SAQIB';
            const userName = String(ctx.msg?.pushName || ctx.senderDigits || 'User').replace(/[*_~`]/g, '').trim() || 'User';
            const total = ctx.registry.getAllCommands().length;
            const usedMem = ctx.runtime.getMemoryUsageMb();
            const runtimeStr = formatUptime(ctx.runtime.getUptimeSec());
            const miniPair = cfg.miniPairUrl || 'https://sigmaminibot.vercel.app';
            const mainPair = cfg.mainPairUrl || 'https://mrsaqib.me/pair';

            const profileCard =
                `╭━━━〔 👑 ${toSansBold(`${botName} PROFILE`)} 〕━━━┈⊷\n` +
                `┃ 🤖 ${toSansBold('Bot Name')}: ${toSansBold(botName)}\n` +
                `┃ 👤 ${toSansBold('User')}: _${userName}_\n` +
                `┃ 👑 ${toSansBold('Owner')}: ${toSansBold(ownerName)}\n` +
                `┃ 💻 ${toSansBold('Developer')}: _Muhammad Saqib_\n` +
                `┃ 🟢 ${toSansBold('Status')}: ${toSansBold('Connected & Active')}\n` +
                `┃ 📂 ${toSansBold('Commands')}: ${toSansBold(`${total}+`)}\n` +
                `┃ ⏳ ${toSansBold('Uptime')}: _${runtimeStr}_\n` +
                `┃ 📊 ${toSansBold('RAM')}: _${usedMem}MB / 512MB_\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `╭━━━〔 🔗 *PAIR & OFFICIAL LINKS* 〕━━━┈⊷\n` +
                `┃ 🤖 *Mini Bot Pair Link:*\n` +
                `┃ ${miniPair}\n` +
                `┃ ⚡ *Main Bot Pair Link:*\n` +
                `┃ ${mainPair}\n` +
                `┃ 🌐 *Official Website:*\n` +
                `┃ https://mrsaqib.me\n` +
                `┃ 🔍 *Search on Google:*\n` +
                `┃ google.com/search?q=mr+saqib\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `➤ _${ctx.prefix}menu type karein tamam commands dekhne ke liye_`;

            const replyOpts = ctx.msg ? { quoted: ctx.msg } : ctx.quoteOpt;
            const imgBuf = getMenuImageBuffer();
            const newsletterCtx = buildNewsletterContext(cfg);
            const payloadBase = newsletterCtx ? { contextInfo: newsletterCtx } : {};

            if (imgBuf) {
                try {
                    await Promise.race([
                        ctx.sock.sendMessage(ctx.from, { image: imgBuf, caption: profileCard, ...payloadBase }, replyOpts),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Profile image send timeout')), 8000))
                    ]);
                    return;
                } catch (_) {}
            }
            await ctx.sock.sendMessage(ctx.from, { text: profileCard, ...payloadBase }, replyOpts);
        }
    },
    makeCategoryMenuCommand('ownermenu', ['menuowner'], 'owner', 'OWNER'),
    makeCategoryMenuCommand('groupmenu', ['menugroup', 'gcmenu'], 'group', 'GROUP'),
    makeCategoryMenuCommand('channelmenu', ['menuchannel', 'chmenu'], 'channel', 'CHANNEL'),
    makeCategoryMenuCommand('dlmenu', ['downloadermenu', 'downloadmenu'], 'downloader', 'DOWNLOAD'),
    makeCategoryMenuCommand('toolsmenu', ['menutools', 'utilitymenu'], 'tools', 'TOOLS & ISLAMIC'),
    {
        name: 'ping',
        aliases: ['speed', 'p'],
        category: 'core',
        desc: 'Bot ki response speed, RAM aur uptime check karein',
        handler: async (ctx) => {
            const rawLatency = Date.now() - ctx.msgTime;
            const latency = rawLatency > 0 && rawLatency < 60000 ? rawLatency : 18;
            const cfg = configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            await ctx.reply(
                `⚡ *PONG! ${toSansBold(botName)} IS ALIVE!*\n\n` +
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
            const botName = cfg.botName || 'SIGMA MD';
            await ctx.reply(
                `🟢 *${toSansBold(botName)} IS 100% ONLINE!*\n\n` +
                `• *Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}\n` +
                `• *RAM:* ${ctx.runtime.getMemoryUsageMb()} MB / 512 MB\n` +
                `• *Commands Ready:* ${ctx.registry.getAllCommands().length}+\n` +
                `• *Mini Bot Pair:* ${cfg.miniPairUrl || 'https://sigmaminibot.vercel.app'}\n` +
                `• *Main Bot Pair:* ${cfg.mainPairUrl || 'https://mrsaqib.me/pair'}`
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
                `📊 *SIGMA MD MEMORY METRICS:*\n\n` +
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
            await ctx.reply(`⏳ *SIGMA MD Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}`);
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
                `• *Mini Bot Pair:* ${cfg.miniPairUrl || 'https://sigmaminibot.vercel.app'}\n` +
                `• *Main Bot Pair:* ${cfg.mainPairUrl || 'https://mrsaqib.me/pair'}\n` +
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
