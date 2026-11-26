'use strict';

/**
 * SIGMA MD :: Useful Search, Converter, Islamic & Utility Tools (25 commands)
 */

const crypto = require('crypto');
const { httpClient, withTtlCache, isSafePublicHttpUrl, unwrapMessage, getTextFromContent, extractTargetJid, resolveJidToDigits, extractMedia, formatBytes } = require('../mediaHelper');

let _QRCode = null;
const getQR = () => (_QRCode || (_QRCode = require('qrcode')));

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
        aliases: ['tr', 'trt', 'trans', 'trns'],
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
            const out = await withTtlCache(`tr:${lang}:${text.slice(0, 120)}`, 600000, async () => {
                try {
                    return await Promise.any([
                        (async () => {
                            const { data } = await httpClient.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`, { timeout: 6000 });
                            const joined = (data?.[0] || []).map((chunk) => chunk?.[0] || '').join('').trim();
                            if (!joined) throw new Error('empty');
                            return joined;
                        })(),
                        (async () => {
                            const pair = lang === 'en' ? 'ur|en' : `en|${lang}`;
                            const { data } = await httpClient.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`, { timeout: 6000 });
                            const res = data?.responseData?.translatedText || '';
                            if (!res) throw new Error('empty');
                            return res;
                        })()
                    ]);
                } catch (_) {
                    return '';
                }
            });

            if (!out) throw new Error('Translation service abhi busy hai.');
            await ctx.reply(`🌐 *TRANSLATION (${lang.toUpperCase()}):*\n\n${out}`);
        }
    },
    {
        name: 'tts',
        aliases: ['speak', 'voice', 'bolo', 'voicenote'],
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
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=${encodeURIComponent(lang)}&total=1&idx=0&textlen=${text.slice(0, 200).length}&client=tw-ob`;
            await ctx.sock.sendMessage(ctx.from, { audio: { url }, mimetype: 'audio/mp4', ptt: true }, ctx.quoteOpt);
        }
    },
    {
        name: 'weather',
        aliases: ['mausam', 'w', 'mosam', 'temp'],
        category: 'tools',
        desc: 'Kisi bhi shehar ka live weather report dekhein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}weather Lahore*`);
            const data = await withTtlCache(`weather:${ctx.fullArgs.toLowerCase()}`, 180000, async () => {
                const r = await httpClient.get(`https://wttr.in/${encodeURIComponent(ctx.fullArgs)}?format=j1`, {
                    timeout: 8000,
                    headers: { 'User-Agent': 'curl/8.0' }
                });
                return r.data;
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
            const data = await withTtlCache(`wiki:${ctx.fullArgs.toLowerCase()}`, 600000, async () => {
                const r = await httpClient.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(ctx.fullArgs)}`, {
                    timeout: 8000,
                    headers: { 'User-Agent': 'MiniBot/2.0 (https://github.com/saqibteamwork-rgb/saqibminobot)' }
                });
                return r.data;
            });
            if (!data?.extract) return ctx.reply('❌ Wikipedia par article nahi mila.');
            await ctx.reply(`📚 *WIKIPEDIA: ${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls?.desktop?.page || ''}`);
        }
    },
    {
        name: 'qr',
        aliases: ['qrcode', 'qrgen'],
        category: 'tools',
        desc: 'Kisi text ya URL ka QR Code image banayein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}qr https://whatsapp.com*`);
            const png = await getQR().toBuffer(ctx.fullArgs, { width: 512, margin: 2 });
            await ctx.sock.sendMessage(ctx.from, { image: png, caption: `📱 *QR Code Generated!*` }, ctx.quoteOpt);
        }
    },
    {
        name: 'shorturl',
        aliases: ['short', 'tinyurl', 'shorten'],
        category: 'tools',
        desc: 'Lamba URL short karein',
        handler: async (ctx) => {
            const safeUrl = isSafePublicHttpUrl(ctx.args[0]);
            if (!safeUrl) return ctx.reply(`Usage: *${ctx.prefix}shorturl https://example.com/long-path*`);
            const data = await withTtlCache(`short:${safeUrl}`, 600000, async () => {
                const r = await httpClient.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(safeUrl)}`, { timeout: 7000 });
                return String(r.data).trim();
            });
            await ctx.reply(`🔗 *Short URL:* ${data}`);
        }
    },
    {
        name: 'calc',
        aliases: ['math', 'calculate', 'hisab', 'calculator'],
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
            const data = await withTtlCache(`fx:${fromC}`, 180000, async () => {
                const r = await httpClient.get(`https://open.er-api.com/v6/latest/${encodeURIComponent(fromC)}`, { timeout: 8000 });
                return r.data;
            });
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
            const q = (ctx.fullArgs || 'Asia/Karachi').trim().toLowerCase();
            const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Karachi'];
            const matched = zones.find((z) => z.toLowerCase().includes(q)) || 'Asia/Karachi';
            const now = new Date();
            const dateStr = new Intl.DateTimeFormat('en-US', { timeZone: matched, weekday: 'long', year: 'numeric', month: 'short', day: '2-digit' }).format(now);
            const timeStr = new Intl.DateTimeFormat('en-US', { timeZone: matched, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(now);
            await ctx.reply(`🕰️ *WORLD CLOCK*\n📍 *Zone:* ${matched}\n📅 *Date:* ${dateStr}\n⏰ *Time:* ${timeStr}`);
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
            const data = await withTtlCache(`ip:${target.toLowerCase()}`, 600000, async () => {
                const r = await httpClient.get(`http://ip-api.com/json/${encodeURIComponent(target)}?fields=status,country,regionName,city,isp,org,query`, { timeout: 8000 });
                return r.data;
            });
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
            const data = await withTtlCache(`gh:${user.toLowerCase()}`, 300000, async () => {
                const r = await httpClient.get(`https://api.github.com/users/${user}`, { timeout: 8000 });
                return r.data;
            });
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
            const data = await withTtlCache(`def:${word.toLowerCase()}`, 900000, async () => {
                const r = await httpClient.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { timeout: 8000 });
                return r.data;
            });
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
        aliases: ['password', 'genpass', 'gpass', 'strongpass'],
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
        aliases: ['rm', 'spoiler', 'rmore'],
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
            const { data } = await httpClient.get('https://dummyjson.com/quotes/random', { timeout: 7000 });
            await ctx.reply(`💬 _"${data.quote}"_\n\n— *${data.author}*`);
        }
    },
    {
        name: 'fact',
        aliases: ['facts'],
        category: 'tools',
        desc: 'Mazedaar random knowledge fact',
        handler: async (ctx) => {
            const { data } = await httpClient.get('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en', { timeout: 7000 });
            await ctx.reply(`💡 *DID YOU KNOW?*\n\n${data.text}`);
        }
    },
    {
        name: 'joke',
        aliases: ['jokes'],
        category: 'tools',
        desc: 'Random English clean joke',
        handler: async (ctx) => {
            const text = await Promise.any([
                httpClient.get('https://v2.jokeapi.dev/joke/Programming,Misc?safe-mode', { timeout: 6000 }).then(({ data }) => {
                    if (data?.setup && data?.delivery) return `😂 *${data.setup}*\n\n👉 _${data.delivery}_`;
                    if (data?.joke) return `😂 ${data.joke}`;
                    throw new Error('empty');
                }),
                httpClient.get('https://official-joke-api.appspot.com/random_joke', { timeout: 6000 }).then(({ data }) => {
                    if (!data?.setup) throw new Error('empty');
                    return `😂 *${data.setup}*\n\n👉 _${data.punchline}_`;
                })
            ]);
            await ctx.reply(text);
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
            const data = await withTtlCache(`quran:${ref}`, 1800000, async () => {
                const r = await httpClient.get(`https://api.alquran.cloud/v1/ayah/${ref}/editions/quran-uthmani,ur.jalandhry`, { timeout: 8000 });
                return r.data;
            });
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
        aliases: ['namaz', 'salah', 'praytime', 'namaztime'],
        category: 'tools',
        desc: 'Shehar ke daily Namaz timings (.namaz Lahore)',
        handler: async (ctx) => {
            const city = ctx.fullArgs || 'Lahore';
            const data = await withTtlCache(`namaz:${city.toLowerCase()}`, 1800000, async () => {
                const r = await httpClient.get(`https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=&method=1`, { timeout: 8000 });
                return r.data;
            });
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
        aliases: ['getjid', 'id', 'chatid', 'gcjid', 'gjid'],
        category: 'tools',
        desc: 'Current chat, user ya replied user ka WhatsApp JID dekhein',
        handler: async (ctx) => {
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta);
            await ctx.reply(`🆔 *Chat JID:* \`${ctx.from}\`${target ? `\n👤 *Target JID:* \`${target}\`` : ''}\n📱 *Sender Digits:* \`${ctx.senderDigits}\``);
        }
    },
    {
        name: 'getpp',
        aliases: ['dp', 'profilepic', 'getdp', 'pfp', 'getpfp', 'pp', 'userdp', 'viewdp', 'showdp'],
        category: 'tools',
        desc: 'Apni ya mentioned user ki WhatsApp profile photo fetch karein',
        handler: async (ctx) => {
            const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta) || ctx.senderRawJid || ctx.from;
            const url = await ctx.sock.profilePictureUrl(target, 'image').catch(() => null);
            if (!url) return ctx.reply('🔒 User ki DP private hai ya available nahi.');
            await ctx.sock.sendMessage(ctx.from, { image: { url }, caption: `🖼️ *Profile Pic:* ${target.split('@')[0]}` }, ctx.quoteOpt);
        }
    },
    {
        name: 'tourl',
        aliases: ['url', 'upload', 'imgurl', 'fileurl', 'mediaurl', 'tolink'],
        category: 'tools',
        desc: 'Kisi bhi photo, video, audio ya sticker ko public Catbox URL mein badlein',
        handler: async (ctx) => {
            const media = await extractMedia(ctx.quotedMsg || ctx.content);
            if (!media?.buffer?.length) {
                return ctx.reply(`Usage: Kisi *Image, Video, Audio ya Sticker* par reply karke *${ctx.prefix}tourl* likhein!`);
            }
            ctx.react('⏳');
            const extMap = {
                image: String(media.mimetype || '').includes('png') ? 'png' : 'jpg',
                video: 'mp4',
                audio: String(media.mimetype || '').includes('ogg') ? 'ogg' : 'mp3',
                sticker: 'webp'
            };
            const ext = extMap[media.mediaType] || ((media.fileName && media.fileName.includes('.')) ? media.fileName.split('.').pop() : 'bin');
            const form = new FormData();
            form.append('reqtype', 'fileupload');
            form.append('fileToUpload', new Blob([media.buffer], { type: media.mimetype || 'application/octet-stream' }), `sigma_${Date.now()}.${ext}`);

            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30000);
            try {
                const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form, signal: ctrl.signal });
                const outUrl = (await res.text()).trim();
                if (!/^https?:\/\//i.test(outUrl)) throw new Error(outUrl || 'Upload failed');
                await ctx.reply(
                    `🔗 *MEDIA UPLOADED TO CLOUD!*\n` +
                    `• *Size:* ${formatBytes(media.buffer.length)}\n` +
                    `• *URL:* ${outUrl}`
                );
                ctx.react('✅');
            } catch (e) {
                await ctx.reply(`❌ *Upload Error:* ${e.message}`);
            } finally {
                clearTimeout(timer);
            }
        }
    },
    {
        name: 'wame',
        aliases: ['walink', 'wame2', 'wa', 'chatlink'],
        category: 'tools',
        desc: 'Kisi bhi number ya mentioned user ka direct wa.me chat link banayein',
        handler: async (ctx) => {
            let clean = ctx.fullArgs.replace(/[^0-9]/g, '');
            if (!clean) {
                const target = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta);
                if (target) clean = target.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                else clean = ctx.senderDigits;
            }
            if (!clean || clean.length < 7) {
                return ctx.reply(`Usage: *${ctx.prefix}wame 923438673242* ya kisi user ke message par reply karein.`);
            }
            await ctx.reply(`📱 *DIRECT WHATSAPP LINK:*\n• *Number:* +${clean}\n• *Link:* https://wa.me/${clean}`);
        }
    },
    {
        name: 'hadith',
        aliases: ['hadees', 'bukhari'],
        category: 'tools',
        desc: 'Sahih al-Bukhari se random Hadith share karein',
        handler: async (ctx) => {
            const fallback = [
                'The best among you are those who have the best manners and character. (Sahih al-Bukhari)',
                'None of you truly believes until he wishes for his brother what he wishes for himself. (Sahih al-Bukhari)',
                'Whoever believes in Allah and the Last Day should speak good or remain silent. (Sahih al-Bukhari)',
                'The strong person is not the one who can wrestle, but the one who controls himself in anger. (Sahih al-Bukhari)'
            ];
            try {
                const list = await withTtlCache('hadith:bukhari100', 3600000, async () => {
                    const r = await httpClient.get('https://api.hadith.gading.dev/books/bukhari?range=1-100', { timeout: 8000 });
                    return r.data?.data?.hadiths || [];
                });
                if (Array.isArray(list) && list.length) {
                    const pick = list[Math.floor(Math.random() * list.length)];
                    const body = pick.id || pick.arab || pick.text || fallback[0];
                    return ctx.reply(`📿 *HADITH — Sahih al-Bukhari #${pick.number}*\n\n${String(body).slice(0, 1500)}`);
                }
            } catch (_) {}
            await ctx.reply(`📿 *HADITH*\n\n${fallback[Math.floor(Math.random() * fallback.length)]}`);
        }
    },
    {
        name: 'dua',
        aliases: ['duas', 'supplication'],
        category: 'tools',
        desc: 'Masnoon Dua Arabic & Urdu/English tarjuma ke sath',
        handler: async (ctx) => {
            const duas = [
                { title: 'Dua for Ease', ar: 'اللَّهُمَّ لاَ سَهْلَ إِلاَّ مَا جَعَلْتَهُ سَهْلاً', en: 'O Allah, nothing is easy except what You make easy.' },
                { title: 'Dua for Knowledge', ar: 'رَّبِّ زِدْنِي عِلْمًا', en: 'My Lord, increase me in knowledge.' },
                { title: 'Dua for Forgiveness', ar: 'رَبِّ اغْفِرْ لِي وَتُبْ عَلَيَّ', en: 'My Lord, forgive me and accept my repentance.' },
                { title: 'Dua for Protection', ar: 'أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّاتِ مِنْ شَرِّ مَا خَلَقَ', en: 'I seek refuge in Allah\'s perfect words from all harm.' }
            ];
            const d = duas[Math.floor(Math.random() * duas.length)];
            await ctx.reply(`🤲 *${d.title}*\n\n${d.ar}\n\n_${d.en}_`);
        }
    },
    {
        name: 'azkar',
        aliases: ['adhkar', 'zikr'],
        category: 'tools',
        desc: 'Morning / Evening aur Hifazat ke Masnoon Azkar',
        handler: async (ctx) => {
            const list = [
                { t: 'Morning Azkar', ar: 'أَصْبَحْنَا وَأَصْبَحَ الْمُلْكُ لِلَّهِ، وَالْحَمْدُ لِلَّهِ', en: 'We have reached the morning and all sovereignty belongs to Allah.' },
                { t: 'Protection Azkar', ar: 'بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الْأَرْضِ وَلَا فِي السَّمَاءِ', en: 'In the name of Allah, with whose Name nothing in earth or heaven causes harm.' },
                { t: 'Evening / Reliance', ar: 'حَسْبِيَ اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ عَلَيْهِ تَوَكَّلْتُ', en: 'Sufficient for me is Allah; there is no deity except Him; in Him I trust.' }
            ];
            const z = list[Math.floor(Math.random() * list.length)];
            await ctx.reply(`🌙 *${z.t}*\n\n${z.ar}\n\n_${z.en}_`);
        }
    },
    {
        name: 'tasbeeh',
        aliases: ['tasbih', 'dhikr'],
        category: 'tools',
        desc: 'Digital Tasbeeh Counter (.tasbeeh / .tasbeeh reset)',
        handler: async (ctx) => {
            if (!global.__sigmaTasbeehMap) global.__sigmaTasbeehMap = new Map();
            const map = global.__sigmaTasbeehMap;
            const key = ctx.senderDigits || ctx.from;
            if ((ctx.args[0] || '').toLowerCase() === 'reset') {
                map.set(key, 0);
                return ctx.reply('📿 *Tasbeeh Counter Reset!* Count: *0*');
            }
            if (map.size >= 500) map.delete(map.keys().next().value);
            const next = (map.get(key) || 0) + 1;
            map.set(key, next);
            const phrase = ['SubhanAllah', 'Alhamdulillah', 'Allahu Akbar'][Math.floor((next - 1) / 33) % 3];
            await ctx.reply(`📿 *DIGITAL TASBEEH*\n• *Dhikr:* ${phrase}\n• *Count:* ${next}\n_(Reset ke liye *${ctx.prefix}tasbeeh reset*)_`);
        }
    },
    {
        name: 'lyrics',
        aliases: ['lyric', 'songlyrics'],
        category: 'tools',
        desc: 'Kisi bhi song ke lyrics search karein (.lyrics Shape of You)',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}lyrics <song name>*`);
            const q = ctx.fullArgs;
            const hit = await withTtlCache(`lyrics:${q.toLowerCase()}`, 600000, async () => {
                const res = await httpClient.get(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { timeout: 10000 });
                const list = Array.isArray(res.data) ? res.data : [];
                return list.find(x => x?.plainLyrics) || null;
            });
            if (!hit) return ctx.reply('❌ Is song ke lyrics nahi mile.');
            await ctx.reply(`🎵 *${hit.trackName || q}* — _${hit.artistName || 'Unknown'}_\n\n${String(hit.plainLyrics).slice(0, 3200)}`);
        }
    },
    {
        name: 'binary',
        aliases: ['bin2text', 'text2bin'],
        category: 'tools',
        desc: 'Text ko Binary ya Binary ko Text mein convert karein',
        handler: async (ctx) => {
            const sub = (ctx.args[0] || '').toLowerCase();
            if (sub === 'dec' || sub === 'decode') {
                const bin = ctx.args.slice(1).join(' ').trim();
                if (!bin) return ctx.reply(`Usage: *${ctx.prefix}binary dec 01001000 01101001*`);
                const text = bin.split(/\s+/).map(b => (/^[01]+$/.test(b) ? String.fromCharCode(parseInt(b, 2)) : '')).join('');
                return ctx.reply(`🔓 *Decoded Text:*\n${text}`);
            }
            const raw = sub === 'enc' || sub === 'encode' ? ctx.args.slice(1).join(' ') : ctx.fullArgs;
            if (!raw) return ctx.reply(`Usage: *${ctx.prefix}binary Hello* | *${ctx.prefix}binary dec 01001000*`);
            const bin = Array.from(raw).map(ch => ch.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
            await ctx.reply(`💻 *Binary Output:*\n\`${bin.slice(0, 1500)}\``);
        }
    },
    {
        name: 'fetch',
        aliases: ['geturl', 'curlsite'],
        category: 'tools',
        desc: 'Kisi public URL ya API se raw JSON/Text fetch karein',
        handler: async (ctx) => {
            const safeUrl = isSafePublicHttpUrl(ctx.args[0]);
            if (!safeUrl) return ctx.reply(`Usage: *${ctx.prefix}fetch https://api.github.com* (public URL only)`);
            const res = await httpClient.get(safeUrl, { timeout: 10000, maxContentLength: 2 * 1024 * 1024, responseType: 'text', transformResponse: [(d) => d] });
            const out = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
            await ctx.reply(`🌐 *HTTP ${res.status} Response:*\n\`\`\`${String(out).slice(0, 3000)}\`\`\``);
        }
    },
    {
        name: 'meme',
        aliases: ['memes', 'randommeme'],
        category: 'tools',
        desc: 'Fresh trending Meme image fetch karein',
        handler: async (ctx) => {
            const r = await httpClient.get('https://meme-api.com/gimme', { timeout: 9000 });
            if (!r.data?.url || r.data.nsfw) return ctx.reply('❌ Fresh meme fetch nahi ho saka, dobara try karein.');
            await ctx.sock.sendMessage(ctx.from, {
                image: { url: r.data.url },
                caption: `😂 *${r.data.title || 'Meme'}*\n📌 _r/${r.data.subreddit || 'memes'}_`
            }, ctx.quoteOpt);
        }
    },
    {
        name: 'reportblock',
        aliases: ['blockreport', 'scamblock', 'rb'],
        category: 'tools',
        desc: 'Apne paired account se scammer ko WhatsApp block karein + official Support Report draft banayein',
        handler: async (ctx) => {
            const raw = String(ctx.fullArgs || '');
            let digits = '';
            let details = '';

            if (raw.includes('|')) {
                const parts = raw.split('|').map(s => s.trim());
                let cand = parts[0].replace(/[^0-9]/g, '');
                if (cand.startsWith('00')) cand = cand.slice(2);
                else if (cand.startsWith('0')) cand = '92' + cand.slice(1);
                else if (cand.startsWith('3') && cand.length === 10) cand = '92' + cand;
                if (cand.length >= 10 && cand.length <= 15) {
                    digits = cand;
                    details = parts.slice(1).join(' | ').trim();
                } else {
                    details = raw;
                }
            } else if (raw) {
                const match = raw.match(/(?:\+?\d[\d\s-]{8,16}\d)/);
                if (match) {
                    let cand = match[0].replace(/[^0-9]/g, '');
                    if (cand.startsWith('00')) cand = cand.slice(2);
                    else if (cand.startsWith('0')) cand = '92' + cand.slice(1);
                    else if (cand.startsWith('3') && cand.length === 10) cand = '92' + cand;
                    if (cand.length >= 10 && cand.length <= 15) {
                        digits = cand;
                        details = raw.replace(match[0], '').trim();
                    } else {
                        details = raw;
                    }
                } else {
                    details = raw;
                }
            }

            if (!digits) {
                const targetJid = extractTargetJid(ctx.msg, ctx.args, ctx.content, ctx.groupMeta);
                if (targetJid) {
                    digits = (await resolveJidToDigits(ctx.sock, targetJid, null, ctx.groupMeta)) || '';
                }
            }

            if (!digits || digits.length < 10) {
                return ctx.reply(
                    `🛡️ *REPORT & BLOCK (.reportblock)*\n\n` +
                    `Usage: *${ctx.prefix}reportblock 923XXXXXXXXX | Scam details*\n` +
                    `_Ya kisi user ke message par reply karke ${ctx.prefix}reportblock <details> likhein._`
                );
            }

            const ownDigits = String(ctx.sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            if (ownDigits && ownDigits === digits) {
                return ctx.reply('❌ Aap apna khud ka number report/block nahi kar sakte.');
            }

            const quotedText = ctx.quotedMsg ? getTextFromContent(unwrapMessage(ctx.quotedMsg)) : '';
            const finalDetails = (details || quotedText || 'Fraud / scam activity on WhatsApp.').slice(0, 600);
            let blockLine = 'ℹ️ *WhatsApp Block:* Skipped (sirf paired bot owner apni blocklist update kar sakta hai)';

            if (ctx.isOwner) {
                try {
                    await ctx.sock.updateBlockStatus(`${digits}@s.whatsapp.net`, 'block');
                    blockLine = `🚫 *WhatsApp Block:* Done (+${digits} blocked on your paired account)`;
                } catch (e) {
                    blockLine = `⚠️ *WhatsApp Block Failed:* ${e.message}`;
                }
            }

            const emailDraft =
                `To: WhatsApp Trust & Safety Team\n` +
                `Subject: Urgent Scam & Fraud Report - +${digits}\n` +
                `Date: ${new Date().toDateString()}\n\n` +
                `Dear WhatsApp Support Team,\n\n` +
                `I am reporting WhatsApp account +${digits} for scam/fraudulent activity.\n` +
                `Reporter Number: ${ownDigits ? `+${ownDigits}` : 'Paired User'}\n` +
                `Incident Details: ${finalDetails}\n\n` +
                `Please review and take action under WhatsApp Terms of Service.`;

            await ctx.reply(
                `╭━━━〔 🛡️ *SCAM REPORT & BLOCK* 〕━━━┈⊷\n` +
                `┃ 🎯 *Target:* +${digits}\n` +
                `┃ ${blockLine}\n` +
                `┃ 📧 *Report Email:* report@support.whatsapp.com\n` +
                `┃ 📧 *Abuse Email:* abuse@support.whatsapp.com\n` +
                `┃ ⚖️ *FIA Helpline (PK):* 1991\n` +
                `┃ 📱 *Manual App Report:* Chat > ⋮ > More > Report\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `📄 *READY SUPPORT EMAIL DRAFT (Copy & Email):*\n` +
                `\`\`\`\n${emailDraft}\n\`\`\``
            );
        }
    }
];

module.exports = commands;
