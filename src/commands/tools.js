'use strict';

/**
 * MINI BOT MD :: Useful Search, Converter, Islamic & Utility Tools (25 commands)
 */

const axios = require('axios');
const crypto = require('crypto');
const QRCode = require('qrcode');
const googleTTS = require('google-tts-api');
const moment = require('moment-timezone');
const { isSafePublicHttpUrl, unwrapMessage, getTextFromContent, extractTargetJid } = require('../mediaHelper');

// Safe pure arithmetic expression evaluator (ZERO eval / new Function!)
function safeMathEval(expr) {
    const clean = String(expr || '').replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
    if (!clean || clean.length > 100 || /[^0-9+\-*/%^().]/.test(clean)) {
        throw new Error('Sirf numbers aur + - * / % ^ ( ) use karein.');
    }
    let pos = 0;
    const peek = () => clean[pos];
    const eat = () => clean[pos++];

    function parseExpr() {
        let val = parseTerm();
        while (peek() === '+' || peek() === '-') {
            const op = eat();
            const rhs = parseTerm();
            val = op === '+' ? val + rhs : val - rhs;
        }
        return val;
    }
    function parseTerm() {
        let val = parsePower();
        while (peek() === '*' || peek() === '/' || peek() === '%') {
            const op = eat();
            const rhs = parsePower();
            if (op === '/') {
                if (rhs === 0) throw new Error('Division by zero');
                val /= rhs;
            } else if (op === '%') {
                val %= rhs;
            } else {
                val *= rhs;
            }
        }
        return val;
    }
    function parsePower() {
        const base = parseFactor();
        if (peek() === '^') {
            eat();
            return Math.pow(base, parsePower());
        }
        return base;
    }
    function parseFactor() {
        if (peek() === '+') { eat(); return parseFactor(); }
        if (peek() === '-') { eat(); return -parseFactor(); }
        if (peek() === '(') {
            eat();
            const v = parseExpr();
            if (eat() !== ')') throw new Error('Mismatched parenthesis');
            return v;
        }
        const start = pos;
        while (pos < clean.length && /[0-9.]/.test(clean[pos])) pos++;
        if (start === pos) throw new Error('Invalid expression');
        const num = Number(clean.slice(start, pos));
        if (!Number.isFinite(num)) throw new Error('Invalid number');
        return num;
    }

    const res = parseExpr();
    if (pos !== clean.length || !Number.isFinite(res)) throw new Error('Invalid math syntax');
    return res;
}

const FANCY_MAPS = [
    ['Bold', '𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇'],
    ['Italic', '𝘈𝘉𝘊𝘋𝘌𝘍𝘎𝘏𝘐𝘑𝘒𝘓𝘔𝘕𝘖𝘗𝘘𝘙𝘚𝘛𝘜𝘝𝘞𝘟𝘠𝘡𝘢𝘣𝘤𝘥𝘦𝘧𝘨𝘩𝘪𝘫𝘬𝘭𝘮𝘯𝘰𝘱𝘲𝘳𝘴𝘵𝘶𝘷𝘸𝘹𝘺𝘻'],
    ['Script', '𝒜𝐵𝒞𝒟𝐸𝐹𝒢𝐻𝐼𝒥𝒦𝐿𝑀𝒩𝒪𝒫𝒬𝑅𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵𝒶𝒷𝒸𝒹𝑒𝒻𝑔𝒽𝒾𝒿𝓀𝓁𝓂𝓃𝑜𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏'],
    ['Monospace', '𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝕏𝚈𝚉𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣'],
    ['SmallCaps', 'ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ']
];
const PLAIN_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function stylizeText(input, alphabet) {
    const chars = Array.from(alphabet);
    return Array.from(input).map((ch) => {
        const idx = PLAIN_ALPHA.indexOf(ch);
        return idx >= 0 && chars[idx] ? chars[idx] : ch;
    }).join('');
}

const commands = [
    {
        name: 'translate',
        aliases: ['tr', 'trt'],
        category: 'tools',
        desc: 'Kisi text ya reply ko kisi bhi language mein translate karein',
        handler: async (ctx) => {
            const quotedText = ctx.quotedMsg ? getTextFromContent(unwrapMessage(ctx.quotedMsg)) : '';
            let lang = 'en';
            let text = '';
            if (quotedText) {
                lang = ctx.args[0] || 'ur';
                text = quotedText;
            } else if (ctx.args.length >= 2) {
                lang = ctx.args[0].toLowerCase();
                text = ctx.args.slice(1).join(' ');
            } else {
                return ctx.reply(`Usage: *${ctx.prefix}tr ur Hello friend!* ya kisi message par reply karke *${ctx.prefix}tr ur* likhein.`);
            }
            const { data } = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`, { timeout: 10000 });
            const out = (data?.[0] || []).map((chunk) => chunk?.[0] || '').join('').trim();
            if (!out) throw new Error('Translation fail ho gayi.');
            await ctx.reply(`🌐 *TRANSLATION (${lang.toUpperCase()}):*\n\n${out}`);
        }
    },
    {
        name: 'tts',
        aliases: ['speak', 'voice'],
        category: 'tools',
        desc: 'Text ko Audio Voice mein badlein (.tts en Hello)',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}tts en Assalam o Alaikum* ya *${ctx.prefix}tts ur Kya haal hai*`);
            let lang = 'en';
            let text = ctx.fullArgs;
            if (/^[a-z]{2}(-[a-z]{2})?$/i.test(ctx.args[0] || '') && ctx.args.length > 1) {
                lang = ctx.args[0].toLowerCase();
                text = ctx.args.slice(1).join(' ');
            }
            const url = googleTTS.getAudioUrl(text.slice(0, 200), { lang, slow: false, host: 'https://translate.google.com' });
            await ctx.sock.sendMessage(ctx.from, { audio: { url }, mimetype: 'audio/mp4', ptt: true }, ctx.quoteOpt);
        }
    },
    {
        name: 'weather',
        aliases: ['mausam', 'w'],
        category: 'tools',
        desc: 'Kisi bhi shehar ka live weather report dekhein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}weather Lahore*`);
            const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(ctx.fullArgs)}?format=j1`, {
                timeout: 12000,
                headers: { 'User-Agent': 'curl/8.0' }
            });
            const cur = data?.current_condition?.[0];
            if (!cur) throw new Error('City weather nahi mila.');
            const area = data.nearest_area?.[0]?.areaName?.[0]?.value || ctx.fullArgs;
            const country = data.nearest_area?.[0]?.country?.[0]?.value || '';
            await ctx.reply(
                `╭━━━〔 🌦️ *WEATHER: ${area}, ${country}* 〕━━━┈⊷\n` +
                `┃ 🌡️ *Temp:* ${cur.temp_C}°C (Feels ${cur.FeelsLikeC}°C)\n` +
                `┃ ☁️ *Sky:* ${cur.weatherDesc?.[0]?.value || 'Clear'}\n` +
                `┃ 💧 *Humidity:* ${cur.humidity}%\n` +
                `┃ 💨 *Wind:* ${cur.windspeedKmph} km/h\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━┈⊷`
            );
        }
    },
    {
        name: 'wiki',
        aliases: ['wikipedia'],
        category: 'tools',
        desc: 'Wikipedia summary search karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}wiki Pakistan*`);
            const { data } = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(ctx.fullArgs)}`, { timeout: 10000 });
            if (!data?.extract) return ctx.reply('❌ Wikipedia par article nahi mila.');
            await ctx.reply(`📚 *WIKIPEDIA: ${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls?.desktop?.page || ''}`);
        }
    },
    {
        name: 'qr',
        aliases: ['qrcode'],
        category: 'tools',
        desc: 'Kisi text ya URL ka QR Code image banayein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}qr https://whatsapp.com*`);
            const png = await QRCode.toBuffer(ctx.fullArgs, { width: 512, margin: 2 });
            await ctx.sock.sendMessage(ctx.from, { image: png, caption: `📱 *QR Code Generated!*` }, ctx.quoteOpt);
        }
    },
    {
        name: 'shorturl',
        aliases: ['short', 'tinyurl'],
        category: 'tools',
        desc: 'Lamba URL short karein',
        handler: async (ctx) => {
            const safeUrl = isSafePublicHttpUrl(ctx.args[0]);
            if (!safeUrl) return ctx.reply(`Usage: *${ctx.prefix}shorturl https://example.com/long-path*`);
            const { data } = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(safeUrl)}`, { timeout: 10000 });
            await ctx.reply(`🔗 *Short URL:* ${String(data).trim()}`);
        }
    },
    {
        name: 'calc',
        aliases: ['math', 'calculate'],
        category: 'tools',
        desc: 'Safe Math Calculator (.calc (25*4)+10)',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}calc (250 * 4) / 5*`);
            const result = safeMathEval(ctx.fullArgs);
            await ctx.reply(`🧮 *Expression:* \`${ctx.fullArgs}\`\n✅ *Result:* *${result}*`);
        }
    },
    {
        name: 'currency',
        aliases: ['fx', 'rate'],
        category: 'tools',
        desc: 'Live currency convert karein (.currency 100 USD PKR)',
        handler: async (ctx) => {
            const amount = parseFloat(ctx.args[0]);
            const fromC = (ctx.args[1] || 'USD').toUpperCase();
            const toC = (ctx.args[2] || 'PKR').toUpperCase();
            if (!Number.isFinite(amount)) return ctx.reply(`Usage: *${ctx.prefix}currency 100 USD PKR*`);
            const { data } = await axios.get(`https://open.er-api.com/v6/latest/${encodeURIComponent(fromC)}`, { timeout: 10000 });
            const rate = data?.rates?.[toC];
            if (!rate) return ctx.reply('❌ Currency code ghalat hai.');
            await ctx.reply(`💱 *${amount} ${fromC} = ${(amount * rate).toFixed(2)} ${toC}*\n📊 Rate: 1 ${fromC} = ${rate} ${toC}`);
        }
    },
    {
        name: 'time',
        aliases: ['clock', 'date'],
        category: 'tools',
        desc: 'Kisi city ya country timezone ka live waqt dekhein',
        handler: async (ctx) => {
            const q = (ctx.fullArgs || 'Asia/Karachi').trim();
            const matched = moment.tz.names().find((z) => z.toLowerCase().includes(q.toLowerCase())) || 'Asia/Karachi';
            const now = moment().tz(matched);
            await ctx.reply(`🕰️ *WORLD CLOCK*\n📍 *Zone:* ${matched}\n📅 *Date:* ${now.format('dddd, DD MMM YYYY')}\n⏰ *Time:* ${now.format('hh:mm:ss A')}`);
        }
    },
    {
        name: 'ip',
        aliases: ['iplookup', 'geoip'],
        category: 'tools',
        desc: 'IP ya domain ki country/ISP info dekhein',
        handler: async (ctx) => {
            const target = (ctx.args[0] || '').trim();
            if (!target || /^(127\.|10\.|192\.168\.|localhost)/i.test(target)) return ctx.reply(`Usage: *${ctx.prefix}ip 8.8.8.8*`);
            const { data } = await axios.get(`http://ip-api.com/json/${encodeURIComponent(target)}?fields=status,country,regionName,city,isp,org,query`, { timeout: 10000 });
            if (data?.status !== 'success') return ctx.reply('❌ Valid public IP ya domain dein.');
            await ctx.reply(`🌐 *IP INFO: ${data.query}*\n🏳️ *Country:* ${data.country}\n🏙️ *City:* ${data.city}, ${data.regionName}\n📡 *ISP:* ${data.isp}`);
        }
    },
    {
        name: 'github',
        aliases: ['gh', 'gitstalk'],
        category: 'tools',
        desc: 'GitHub profile stats dekhein',
        handler: async (ctx) => {
            const user = (ctx.args[0] || '').replace(/[^a-zA-Z0-9-]/g, '');
            if (!user) return ctx.reply(`Usage: *${ctx.prefix}github torvalds*`);
            const { data } = await axios.get(`https://api.github.com/users/${user}`, { timeout: 10000 });
            await ctx.reply(
                `🐙 *GITHUB: ${data.login}*\n` +
                `👤 *Name:* ${data.name || 'N/A'}\n` +
                `📦 *Public Repos:* ${data.public_repos}\n` +
                `👥 *Followers:* ${data.followers} | *Following:* ${data.following}\n` +
                `📝 *Bio:* ${data.bio || 'N/A'}\n` +
                `🔗 ${data.html_url}`
            );
        }
    },
    {
        name: 'define',
        aliases: ['dictionary', 'dict'],
        category: 'tools',
        desc: 'English word ka meaning aur example dekhein',
        handler: async (ctx) => {
            const word = ctx.args[0];
            if (!word) return ctx.reply(`Usage: *${ctx.prefix}define resilient*`);
            const { data } = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { timeout: 10000 });
            const entry = data?.[0];
            const meaning = entry?.meanings?.[0];
            const def = meaning?.definitions?.[0];
            if (!def) return ctx.reply('❌ Word nahi mila.');
            await ctx.reply(
                `📖 *${entry.word}* (${meaning.partOfSpeech})\n\n` +
                `📝 *Meaning:* ${def.definition}` +
                (def.example ? `\n💡 *Example:* _"${def.example}"_` : '')
            );
        }
    },
    {
        name: 'fancy',
        aliases: ['style', 'font'],
        category: 'tools',
        desc: 'Text ko 5 stylish Unicode fonts mein convert karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}fancy MR SAQIB*`);
            const lines = FANCY_MAPS.map(([label, alpha], i) => `${i + 1}. *${label}:* ${stylizeText(ctx.fullArgs, alpha)}`);
            await ctx.reply(`✨ *FANCY FONTS:*\n\n${lines.join('\n')}`);
        }
    },
    {
        name: 'base64',
        aliases: ['b64'],
        category: 'tools',
        desc: 'Base64 encode/decode (.base64 enc|dec <text>)',
        handler: async (ctx) => {
            const mode = (ctx.args[0] || '').toLowerCase();
            const text = ctx.args.slice(1).join(' ');
            if (!['enc', 'dec'].includes(mode) || !text) return ctx.reply(`Usage: *${ctx.prefix}base64 enc Hello* ya *${ctx.prefix}base64 dec SGVsbG8=*`);
            const out = mode === 'enc' ? Buffer.from(text, 'utf8').toString('base64') : Buffer.from(text, 'base64').toString('utf8');
            await ctx.reply(`🔐 *Base64 (${mode.toUpperCase()}):*\n\`${out}\``);
        }
    },
    {
        name: 'hash',
        aliases: ['sha256', 'md5'],
        category: 'tools',
        desc: 'Text ka SHA256 aur MD5 hash generate karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}hash mytext*`);
            const sha = crypto.createHash('sha256').update(ctx.fullArgs).digest('hex');
            const md5 = crypto.createHash('md5').update(ctx.fullArgs).digest('hex');
            await ctx.reply(`🔑 *HASHES:*\n• *SHA256:* \`${sha}\`\n• *MD5:* \`${md5}\``);
        }
    },
    {
        name: 'passgen',
        aliases: ['password', 'genpass'],
        category: 'tools',
        desc: 'Strong random password banayein (.passgen 16)',
        handler: async (ctx) => {
            const len = Math.min(48, Math.max(8, parseInt(ctx.args[0], 10) || 16));
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_-';
            const bytes = crypto.randomBytes(len);
            let out = '';
            for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
            await ctx.reply(`🔐 *Generated Password (${len} chars):*\n\`${out}\``);
        }
    },
    {
        name: 'readmore',
        aliases: ['rm'],
        category: 'tools',
        desc: 'WhatsApp ReadMore message banayein (.readmore Top | Bottom)',
        handler: async (ctx) => {
            const [top, bottom] = (ctx.fullArgs || 'Click Read More! | Ye secret text tha!').split('|');
            const spacer = String.fromCharCode(8206).repeat(4001);
            await ctx.reply(`${(top || '').trim()}${spacer}${(bottom || '').trim()}`);
        }
    },
    {
        name: 'quote',
        aliases: ['quotes', 'inspire'],
        category: 'tools',
        desc: 'Motivational aur inspiring quotes hasil karein',
        handler: async (ctx) => {
            const { data } = await axios.get('https://dummyjson.com/quotes/random', { timeout: 8000 });
            await ctx.reply(`💬 _"${data.quote}"_\n\n— *${data.author}*`);
        }
    },
    {
        name: 'fact',
        aliases: ['facts'],
        category: 'tools',
        desc: 'Mazedaar random knowledge fact',
        handler: async (ctx) => {
            const { data } = await axios.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', { timeout: 8000 });
            await ctx.reply(`💡 *DID YOU KNOW?*\n\n${data.text}`);
        }
    },
    {
        name: 'joke',
        aliases: ['jokes'],
        category: 'tools',
        desc: 'Random English clean joke',
        handler: async (ctx) => {
            const { data } = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 8000 });
            await ctx.reply(`😂 *${data.setup}*\n\n👉 _${data.punchline}_`);
        }
    },
    {
        name: 'quran',
        aliases: ['ayah'],
        category: 'tools',
        desc: 'Quran Surah:Ayah Arabic + Urdu translation (.quran 2:255)',
        handler: async (ctx) => {
            const ref = (ctx.args[0] || '1:1').trim();
            if (!/^\d+:\d+$/.test(ref)) return ctx.reply(`Usage: *${ctx.prefix}quran 2:255* ya *${ctx.prefix}quran 1:1*`);
            const { data } = await axios.get(`https://api.alquran.cloud/v1/ayah/${ref}/editions/quran-uthmani,ur.jalandhry`, { timeout: 10000 });
            const ar = data?.data?.[0];
            const ur = data?.data?.[1];
            if (!ar) return ctx.reply('❌ Ayah nahi mili.');
            await ctx.reply(
                `📖 *${ar.surah?.englishName || 'Surah'} (${ar.surah?.number}:${ar.numberInSurah})*\n\n` +
                `${ar.text}\n\n` +
                (ur ? `🇵🇰 *Tarjuma:*\n${ur.text}` : '')
            );
        }
    },
    {
        name: 'prayertime',
        aliases: ['namaz', 'salah'],
        category: 'tools',
        desc: 'Shehar ke daily Namaz timings (.namaz Lahore)',
        handler: async (ctx) => {
            const city = ctx.fullArgs || 'Lahore';
            const { data } = await axios.get(`https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=&method=1`, { timeout: 10000 });
            const t = data?.data?.timings;
            if (!t) return ctx.reply('❌ City ke namaz timings nahi mile.');
            await ctx.reply(
                `🕌 *NAMAZ TIMINGS: ${city.toUpperCase()}*\n` +
                `📅 *Date:* ${data.data?.date?.readable || ''}\n\n` +
                `• *Fajr:* ${t.Fajr}\n• *Dhuhr:* ${t.Dhuhr}\n• *Asr:* ${t.Asr}\n• *Maghrib:* ${t.Maghrib}\n• *Isha:* ${t.Isha}`
            );
        }
    },
    {
        name: 'reverse',
        aliases: ['rev'],
        category: 'tools',
        desc: 'Text ko ulta (reverse) karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}reverse Hello*`);
            await ctx.reply(`🔁 ${Array.from(ctx.fullArgs).reverse().join('')}`);
        }
    },
    {
        name: 'count',
        aliases: ['wordcount'],
        category: 'tools',
        desc: 'Text ke characters aur words count karein',
        handler: async (ctx) => {
            const text = ctx.fullArgs || (ctx.quotedMsg ? getTextFromContent(unwrapMessage(ctx.quotedMsg)) : '');
            if (!text) return ctx.reply(`Usage: *${ctx.prefix}count <text>* ya kisi message par reply karein.`);
            const words = text.trim().split(/\s+/).filter(Boolean).length;
            await ctx.reply(`📊 *TEXT STATS:*\n• Characters: *${text.length}*\n• Words: *${words}*\n• Lines: *${text.split('\n').length}*`);
        }
    },
    {
        name: 'jid',
        aliases: ['getjid', 'id'],
        category: 'tools',
        desc: 'Current chat, user ya replied user ka WhatsApp JID dekhein',
        handler: async (ctx) => {
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta);
            await ctx.reply(`🆔 *Chat JID:* \`${ctx.from}\`${target ? `\n👤 *Target JID:* \`${target}\`` : ''}\n📱 *Sender Digits:* \`${ctx.senderDigits}\``);
        }
    },
    {
        name: 'getpp',
        aliases: ['dp', 'profilepic'],
        category: 'tools',
        desc: 'Apni ya mentioned user ki WhatsApp profile photo fetch karein',
        handler: async (ctx) => {
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta) || ctx.senderRawJid || ctx.from;
            const url = await ctx.sock.profilePictureUrl(target, 'image').catch(() => null);
            if (!url) return ctx.reply('🔒 User ki DP private hai ya available nahi.');
            await ctx.sock.sendMessage(ctx.from, { image: { url }, caption: `🖼️ *Profile Pic:* ${target.split('@')[0]}` }, ctx.quoteOpt);
        }
    }
];

module.exports = commands;
