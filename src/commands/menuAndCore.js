'use strict';

/**
 * SIGMA MD :: Menu, Profile & Core System Commands
 * Replicates the signature Style 1 aesthetic menu with preloaded SIGMA artwork,
 * live user profile card, and Mini Bot + Main Bot pair links.
 */

const os = require('os');
const configStore = require('../configStore');
const clusterMesh = require('../clusterMesh');
const {
    formatUptime,
    toSansBold,
    getPrimaryOwnerDigits,
    formatReadablePhone,
    buildNewsletterContext,
    sendMediaOrTextCard,
    sendSeparateLinksCard,
    extractTargetJid,
    resolveJidToDigits,
    httpClient
} = require('../mediaHelper');

const pairReqCooldown = new Map();

function normalizePairDigits(raw) {
    if (!raw) return '';
    let n = String(raw).replace(/[^0-9]/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    else if (n.startsWith('0')) n = '92' + n.slice(1);
    else if (n.startsWith('3') && n.length === 10) n = '92' + n;
    return n;
}

async function resolvePairRequestTarget(ctx) {
    let explicitNum = '';
    let customCode = '';
    let hasForce = false;

    for (const arg of (ctx.args || [])) {
        const low = String(arg || '').toLowerCase();
        if (low === 'force' || low === '-f') {
            hasForce = true;
            continue;
        }
        const digits = normalizePairDigits(arg);
        if (!explicitNum && digits.length >= 10 && digits.length <= 15) {
            explicitNum = digits;
            continue;
        }
        const alnum = String(arg || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!customCode && alnum.length === 8 && !/^\d+$/.test(alnum)) {
            customCode = alnum;
        }
    }

    if (explicitNum) return { number: explicitNum, customCode, hasForce };

    const targetJid = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta);
    if (targetJid) {
        const resolved = normalizePairDigits(await resolveJidToDigits(ctx.sock, targetJid, null, ctx.groupMeta));
        if (resolved.length >= 10 && resolved.length <= 15) {
            return { number: resolved, customCode, hasForce };
        }
    }

    const senderClean = normalizePairDigits(ctx.senderDigits);
    if (senderClean.length >= 10 && senderClean.length <= 15) {
        return { number: senderClean, customCode, hasForce };
    }
    return { number: '', customCode, hasForce };
}

function checkPairCooldown(key) {
    const now = Date.now();
    const last = pairReqCooldown.get(key) || 0;
    if (now - last < 12000) return Math.ceil((12000 - (now - last)) / 1000);
    if (pairReqCooldown.size >= 300) pairReqCooldown.delete(pairReqCooldown.keys().next().value);
    pairReqCooldown.set(key, now);
    return 0;
}

async function pickHealthyMainBotNode() {
    return clusterMesh.pickHealthyMainBotNode();
}

async function requestMainBotPair(number, customCode = '') {
    const cfg = configStore.getConfig();
    const primaryBase = String(cfg.mainPairUrl || 'https://mrsaqib.me/pair').replace(/\/pair\/?$/i, '').replace(/\/+$/, '');
    const suffix = customCode ? `&custom=${encodeURIComponent(customCode)}` : '';
    const candidates = [`${primaryBase}/api/pair?number=${encodeURIComponent(number)}${suffix}`];

    let lastData = null;
    for (const url of candidates) {
        try {
            const res = await httpClient.get(url, { timeout: 24000, validateStatus: () => true });
            if (res.data && typeof res.data === 'object') {
                lastData = res.data;
                if (res.data.code || res.data.pairingCode || res.data.status === 'already_connected' || res.data.status === 'connection_in_progress' || res.status === 400) {
                    return { httpStatus: res.status, data: res.data, source: url };
                }
            }
        } catch (_) {}
    }

    const fallbackNode = await pickHealthyMainBotNode();
    const nodeUrl = `${fallbackNode}/api/pair?number=${encodeURIComponent(number)}${suffix}`;
    const nodeRes = await httpClient.get(nodeUrl, { timeout: 24000, validateStatus: () => true });
    return { httpStatus: nodeRes.status, data: nodeRes.data || lastData || {}, source: fallbackNode };
}

async function requestMiniBotPair(number, allowForce = false) {
    const cfg = configStore.getConfig();
    const miniBase = String(cfg.miniPairUrl || 'https://sigmamini.vercel.app').replace(/\/+$/, '');
    const forceQ = allowForce ? '&force=true' : '';
    const urls = [];

    if (!allowForce) {
        const freeNode = await clusterMesh.pickAvailableMiniBotNode(false).catch(() => null);
        if (freeNode) {
            urls.push(`${freeNode}/pair?number=${encodeURIComponent(number)}`);
        }
    }
    urls.push(`${miniBase}/api/pair?number=${encodeURIComponent(number)}${forceQ}`);
    for (const nodeUrl of clusterMesh.getMiniNodes(false)) {
        const ep = `${nodeUrl}/pair?number=${encodeURIComponent(number)}${forceQ}`;
        if (!urls.includes(ep)) urls.push(ep);
    }

    let lastErr = null;
    let lastConflict = null;
    for (const url of urls) {
        try {
            const res = await httpClient.get(url, { timeout: 22000, validateStatus: () => true });
            if (res.data && typeof res.data === 'object') {
                if (res.status === 409) {
                    lastConflict = { httpStatus: 409, data: res.data, source: url };
                    continue;
                }
                if (res.status !== 502 && res.status !== 503 && res.status !== 504) {
                    return { httpStatus: res.status, data: res.data, source: url };
                }
                lastErr = new Error(res.data.error || `HTTP ${res.status}`);
            }
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastConflict) return lastConflict;
    throw lastErr || new Error('Mini Bot server busy hai, kuch second baad try karein.');
}

async function sendCrossPairSuccess(ctx, number, rawCode, opts) {
    const cfg = ctx.tenantConfig || configStore.getConfig();
    const newsletterCtx = buildNewsletterContext(cfg);
    const cleanCode = String(rawCode).replace(/[^A-Za-z0-9]/g, '');
    const formattedCode = String(rawCode).includes('-') ? String(rawCode) : (cleanCode.match(/.{1,4}/g)?.join('-') || cleanCode);
    const msgText =
        `╭━━━〔 ${opts.title} 〕━━━┈⊷\n` +
        `┃ 🤖 *Bot:* ${opts.botLabel}\n` +
        `┃ 📱 *Number:* +${number}\n` +
        `┃ 🔑 *Code:* \`${formattedCode}\`\n` +
        `┃\n` +
        `┃ 📌 *Kaise Link Karein:*\n` +
        `┃ 1. WhatsApp > Linked Devices kholein\n` +
        `┃ 2. "Link a Device" -> "Link with phone number"\n` +
        `┃ 3. Niche diya gaya 8-digit code daalein\n` +
        `┃ ⏰ Code ~60 seconds ke liye valid hai!\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
        `🌐 *Web Dashboard:* ${opts.webUrl}\n` +
        `📋 *Neeche wala code 1-tap copy karein* 👇`;

    // Card 1 includes the "View channel" context pill; Card 2 stays pure clean code (skipChannelCard: true)
    const cardPayload = newsletterCtx ? { text: msgText, contextInfo: newsletterCtx } : { text: msgText };
    await ctx.sock.sendMessage(ctx.from, cardPayload, ctx.quoteOpt);
    await ctx.sock.sendMessage(ctx.from, { text: cleanCode, skipChannelCard: true }, ctx.quoteOpt);
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
    { key: 'sticker', title: 'STICKERS & SFX', aliases: ['sticker', 'stickers', 'sfx', 'lottie', 'stickermenu'] },
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
    const cfg = ctx.tenantConfig || configStore.getConfig();
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
        (cfg.channelLink ? `┃ 📢 ${toSansBold('Channel')}: ${cfg.channelLink}\n` : '') +
        `╰━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
        ` ➤ ${p}${toSansBold('menu')} _type karein commands ke liye_`
    );
}

async function sendStyledMenu(ctx, sections, headerCommandCount) {
    const cfg = ctx.tenantConfig || configStore.getConfig();
    const headerText = buildMenuHeader(ctx, headerCommandCount);
    const boxesText = sections
        .map((sec) => {
            const cmds = ctx.registry.getByCategory(sec.key);
            return cmds.length ? makeBox(sec.title, cmds, ctx.prefix || '.') : '';
        })
        .filter(Boolean)
        .join('\n');
    const fullText = `${headerText}\n\n${boxesText.trim()}`.trim();

    await sendMediaOrTextCard(ctx, cfg, fullText, 'Menu');
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
        aliases: ['help', 'm', 'mene', 'manu'],
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
        aliases: ['list', 'commands', 'cmds', 'allcmd', 'allcmds', 'fullmenu'],
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
        aliases: ['myprofile', 'profileinfo'],
        category: 'core',
        desc: 'Bot profile, developer info aur Mini/Main Bot Pair links dekhein',
        handler: async (ctx) => {
            ctx.react('👑');
            const cfg = ctx.tenantConfig || configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            const ownerName = cfg.ownerName || 'MR SAQIB';
            const ownerDigits = getPrimaryOwnerDigits(cfg);
            const formattedPhone = formatReadablePhone(ownerDigits);
            const userName = String(ctx.msg?.pushName || ctx.senderDigits || 'User').replace(/[*_~`]/g, '').trim() || 'User';
            const total = ctx.registry.getAllCommands().length;
            const usedMem = ctx.runtime.getMemoryUsageMb();
            const runtimeStr = formatUptime(ctx.runtime.getUptimeSec());

            const devLabel = cfg.creatorId ? ownerName : 'Muhammad Saqib';
            const profileCard =
                `╭━━━〔 👑 ${toSansBold(`${botName} PROFILE`)} 〕━━━┈⊷\n` +
                `┃ 🤖 ${toSansBold('Bot Name')}: ${toSansBold(botName)}\n` +
                `┃ 👤 ${toSansBold('User')}: _${userName}_\n` +
                `┃ 👑 ${toSansBold('Owner')}: ${toSansBold(ownerName)}\n` +
                `┃ 📱 ${toSansBold('Owner Number')}: *${formattedPhone}*\n` +
                `┃ 💻 ${toSansBold('Developer')}: _${devLabel}_\n` +
                `┃ 🟢 ${toSansBold('Status')}: ${toSansBold('Connected & Active')}\n` +
                `┃ 📂 ${toSansBold('Commands')}: ${toSansBold(`${total}+`)}\n` +
                `┃ ⏳ ${toSansBold('Uptime')}: _${runtimeStr}_\n` +
                `┃ 📊 ${toSansBold('RAM')}: _${usedMem}MB / 512MB_\n` +
                (cfg.channelLink ? `┃ 📢 ${toSansBold('Channel')}: ${cfg.channelLink}\n` : '') +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `➤ _${ctx.prefix}menu type karein tamam commands dekhne ke liye_`;

            await sendMediaOrTextCard(ctx, cfg, profileCard, 'Profile');
        }
    },
    makeCategoryMenuCommand('ownermenu', ['menuowner'], 'owner', 'OWNER'),
    makeCategoryMenuCommand('groupmenu', ['menugroup', 'gcmenu'], 'group', 'GROUP'),
    makeCategoryMenuCommand('channelmenu', ['menuchannel', 'chmenu'], 'channel', 'CHANNEL'),
    makeCategoryMenuCommand('dlmenu', ['downloadermenu', 'downloadmenu'], 'downloader', 'DOWNLOAD'),
    makeCategoryMenuCommand('stickermenu', ['menusticker', 'sfxmenu'], 'sticker', 'STICKERS & SFX'),
    makeCategoryMenuCommand('toolsmenu', ['menutools', 'utilitymenu'], 'tools', 'TOOLS & ISLAMIC'),
    {
        name: 'ping',
        aliases: ['speed', 'p', 'pong', 'latency', 'ms', 'sp'],
        category: 'core',
        desc: 'Bot ki response speed, RAM aur uptime check karein',
        handler: async (ctx) => {
            const rawLatency = Date.now() - ctx.msgTime;
            const latency = rawLatency > 0 && rawLatency < 60000 ? rawLatency : 18;
            const cfg = ctx.tenantConfig || configStore.getConfig();
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
        aliases: ['status', 'online', 'botstatus', 'isalive', 'botup'],
        category: 'core',
        desc: 'Bot 24/7 active status check karein',
        handler: async (ctx) => {
            const cfg = ctx.tenantConfig || configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            await ctx.reply(
                `🟢 *${toSansBold(botName)} IS 100% ONLINE!*\n\n` +
                `• *Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}\n` +
                `• *RAM:* ${ctx.runtime.getMemoryUsageMb()} MB / 512 MB\n` +
                `• *Commands Ready:* ${ctx.registry.getAllCommands().length}+\n` +
                `• *Mini Bot Pair:* ${cfg.miniPairUrl || 'https://sigmamini.vercel.app'}\n` +
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
            const cfg = ctx.tenantConfig || configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            const m = process.memoryUsage();
            const toMb = (b) => Math.round(b / (1024 * 1024));
            const rss = toMb(m.rss);
            await ctx.reply(
                `📊 *${toSansBold(botName)} MEMORY METRICS:*\n\n` +
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
            const cfg = ctx.tenantConfig || configStore.getConfig();
            const botName = cfg.botName || 'SIGMA MD';
            await ctx.reply(`⏳ *${botName} Uptime:* ${formatUptime(ctx.runtime.getUptimeSec())}`);
        }
    },
    {
        name: 'botinfo',
        aliases: ['info', 'about'],
        category: 'core',
        desc: 'Bot version, Baileys engine aur config status dekhein',
        handler: async (ctx) => {
            const cfg = ctx.tenantConfig || configStore.getConfig();
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
    },
    {
        name: 'pairmd',
        aliases: ['mdpair', 'pairmain', 'mainpair', 'getpair', 'pair'],
        category: 'core',
        desc: 'Mini Bot ke andar se Main Bot (MR SAQIB MD) ka pairing code lein (.pairmd 923xxxxxxxxx)',
        handler: async (ctx) => {
            const { number, customCode } = await resolvePairRequestTarget(ctx);
            const cfg = configStore.getConfig();
            const mainWeb = cfg.mainPairUrl || 'https://mrsaqib.me/pair';
            if (!number) {
                return ctx.reply(
                    `🔑 *MAIN BOT PAIRING (.pairmd)*\n\n` +
                    `Usage: *${ctx.prefix}pairmd 923001234567*\n` +
                    `_Ya kisi user ko mention/reply karke ${ctx.prefix}pairmd likhein._\n` +
                    `🌐 Web Link: ${mainWeb}`
                );
            }
            const waitSec = checkPairCooldown(`md:${ctx.senderDigits || ctx.from}`);
            if (waitSec > 0) {
                return ctx.reply(`⏳ Thora intezar karein! Dubara request ${waitSec}s baad bhejein.`);
            }
            ctx.react('⏳');
            await ctx.reply(`⏳ *+${number}* ke liye *Main Bot (MR SAQIB MD)* ka pairing code generate ho raha hai...`);
            try {
                const { data } = await requestMainBotPair(number, customCode);
                if (data?.status === 'already_connected' || data?.isConnected) {
                    ctx.react('✅');
                    return ctx.reply(`✅ *+${number}* pehle se *Main Bot (MR SAQIB MD)* par connected & online hai!\n🌐 ${mainWeb}`);
                }
                if (data?.status === 'connection_in_progress') {
                    return ctx.reply(`⏳ *+${number}* ki pairing pehle se process ho rahi hai — kuch seconds baad check karein.`);
                }
                const code = data?.code || data?.pairingCode;
                if (!code) {
                    ctx.react('❌');
                    return ctx.reply(`❌ Main Bot pairing failed: ${data?.message || data?.error || 'Code generate nahi ho saka.'}\n🌐 Web se try karein: ${mainWeb}`);
                }
                ctx.react('🔑');
                await sendCrossPairSuccess(ctx, number, code, {
                    title: '🔑 *MAIN BOT PAIRING CODE*',
                    botLabel: 'MR SAQIB MD (Main Bot)',
                    webUrl: mainWeb
                });
            } catch (e) {
                ctx.react('❌');
                await ctx.reply(`❌ *Main Bot Pair Error:* ${e.message}\n🌐 Direct link: ${mainWeb}`);
            }
        }
    },
    {
        name: 'pairmini',
        aliases: ['minipair', 'pairbot'],
        category: 'core',
        desc: 'SIGMA Mini Bot ka pairing code hasil karein (.pairmini 923xxxxxxxxx)',
        handler: async (ctx) => {
            const { number, hasForce } = await resolvePairRequestTarget(ctx);
            const cfg = configStore.getConfig();
            const miniWeb = cfg.miniPairUrl || 'https://sigmamini.vercel.app';
            if (!number) {
                return ctx.reply(
                    `🤖 *MINI BOT PAIRING (.pairmini)*\n\n` +
                    `Usage: *${ctx.prefix}pairmini 923001234567*\n` +
                    `🌐 Web Link: ${miniWeb}`
                );
            }
            const waitSec = checkPairCooldown(`mini:${ctx.senderDigits || ctx.from}`);
            if (waitSec > 0) {
                return ctx.reply(`⏳ Thora intezar karein! Dubara request ${waitSec}s baad bhejein.`);
            }
            ctx.react('⏳');
            await ctx.reply(`⏳ *+${number}* ke liye *SIGMA MINI BOT* pairing code fetch ho raha hai...`);
            try {
                const allowForce = Boolean(ctx.isOwner && hasForce);
                const { httpStatus, data } = await requestMiniBotPair(number, allowForce);
                if (httpStatus === 409) {
                    return ctx.reply(
                        `⚠️ *SIGMA MINI BOT* par abhi ek number pehle se connected hai.\n` +
                        (ctx.isOwner ? `💡 Force re-pair ke liye *${ctx.prefix}pairmini ${number} force* likhein.\n` : '') +
                        `🌐 Web Dashboard: ${miniWeb}`
                    );
                }
                if (httpStatus === 429) {
                    return ctx.reply(`⏳ Mini Bot par ek pairing pehle se chal rahi hai, 10 second baad dubara try karein.`);
                }
                const code = data?.pairingCode || data?.code;
                if (!data?.success || !code) {
                    ctx.react('❌');
                    return ctx.reply(`❌ Mini Bot pairing failed: ${data?.error || 'Code receive nahi hua.'}\n🌐 ${miniWeb}`);
                }
                ctx.react('🔑');
                await sendCrossPairSuccess(ctx, number, code, {
                    title: '🤖 *SIGMA MINI PAIRING CODE*',
                    botLabel: 'SIGMA MD (Mini Bot)',
                    webUrl: miniWeb
                });
            } catch (e) {
                ctx.react('❌');
                await ctx.reply(`❌ *Mini Bot Pair Error:* ${e.message}\n🌐 ${miniWeb}`);
            }
        }
    }
];

module.exports = commands;
