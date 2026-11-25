'use strict';

/**
 * MINI BOT MD :: Multi-Platform Downloader & Media Saver Commands (20 commands)
 * Uses pure JS + streaming URL payloads to stay well within Heroku 512MB RAM.
 */

const crypto = require('crypto');
const https = require('https');
const configStore = require('../configStore');
const { httpClient, withTtlCache, extractMedia, isSafePublicHttpUrl, formatBytes, sleep } = require('../mediaHelper');

let _cheerio = null;
let _yts = null;
let _ytdl = null;
const getCheerio = () => (_cheerio || (_cheerio = require('cheerio')));
const getYts = () => (_yts || (_yts = require('yt-search')));
const getYtdl = () => (_ytdl || (_ytdl = require('ytdl-lite')));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const tlsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

function extractYtId(url) {
    const patterns = [
        /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
    ];
    for (const p of patterns) {
        const m = String(url || '').match(p);
        if (m) return m[1];
    }
    return null;
}

async function savetubeDownload(url, type = 'audio') {
    const id = extractYtId(url);
    if (!id) return null;
    const headers = {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://save-tube.com',
        referer: 'https://save-tube.com/',
        'user-agent': UA
    };
    const { data: cdnRes } = await httpClient.get('https://media.savetube.vip/api/random-cdn', { headers, timeout: 7000 });
    const cdn = cdnRes?.cdn;
    if (!cdn) return null;
    const { data: infoRes } = await httpClient.post(`https://${cdn}/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` }, { headers, timeout: 9000 });
    if (!infoRes?.data) return null;

    const raw = Buffer.from(infoRes.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex'), raw.subarray(0, 16));
    const decrypted = JSON.parse(Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString());

    const isAudio = type === 'audio';
    const { data: dl } = await httpClient.post(`https://${cdn}/download`, {
        id,
        downloadType: isAudio ? 'audio' : 'video',
        quality: isAudio ? '128' : '360',
        key: decrypted.key
    }, { headers, timeout: 10000 });
    if (dl?.data?.downloadUrl) {
        return { url: dl.data.downloadUrl, title: decrypted.title || 'YouTube Media', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
    }
    return null;
}

async function resolveYoutubeMedia(queryOrUrl, type = 'audio') {
    let targetUrl = queryOrUrl;
    let meta = { title: 'YouTube Media', duration: '', author: '', thumb: '' };

    if (!extractYtId(targetUrl)) {
        const v = await withTtlCache(`yts1:${queryOrUrl.toLowerCase()}`, 300000, async () => {
            const search = await getYts()(queryOrUrl);
            if (!search?.videos?.length) throw new Error('Koi YouTube result nahi mila.');
            return search.videos[0];
        });
        targetUrl = v.url;
        meta = { title: v.title, duration: v.timestamp, author: v.author?.name || '', thumb: v.thumbnail };
    }

    return await withTtlCache(`yt:${type}:${targetUrl}`, 600000, async () => {
        // Race fast primary tiers concurrently; fall back to SaveNow polling if needed
        try {
            return await Promise.any([
                (async () => {
                    const ytdl = getYtdl();
                    const r = type === 'audio' ? await ytdl.ytmp3(targetUrl) : await ytdl.ytmp4(targetUrl, '360');
                    if (!r?.url) throw new Error('no ytdl url');
                    return { ...meta, title: r.title || meta.title, url: r.url };
                })(),
                (async () => {
                    const r = await savetubeDownload(targetUrl, type);
                    if (!r?.url) throw new Error('no savetube url');
                    return { ...meta, title: r.title || meta.title, url: r.url, thumb: r.thumb || meta.thumb };
                })(),
                (async () => {
                    const ep = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(targetUrl)}&format=${type === 'audio' ? 'mp3' : 'mp4'}`;
                    const res = await httpClient.get(ep, { timeout: 10000, headers: { 'User-Agent': UA } });
                    if (!res.data?.downloadURL) throw new Error('no ep url');
                    return { ...meta, title: res.data.title || meta.title, url: res.data.downloadURL };
                })()
            ]);
        } catch (_) {}

        try {
            const fmt = type === 'audio' ? 'mp3' : '360';
            const { data: init } = await httpClient.get('https://p.savenow.to/ajax/download.php', {
                params: { copyright: 0, format: fmt, url: targetUrl, api: 'dfcb6d76f2f6a9894gjkege8a4ab232222' },
                httpsAgent: tlsAgent,
                timeout: 10000,
                headers: { 'User-Agent': UA, Referer: 'https://savenow.to/' }
            });
            if (init?.progress_url) {
                for (let i = 0; i < 8; i++) {
                    await sleep(1200);
                    const { data: p } = await httpClient.get(init.progress_url, { httpsAgent: tlsAgent, timeout: 8000 });
                    if (p?.download_url) return { ...meta, title: init.info?.title || meta.title, url: p.download_url };
                    if (p?.success === -1) break;
                }
            }
        } catch (_) {}

        throw new Error('YouTube download server abhi busy hai, thodi der baad try karein.');
    });
}

async function fetchTikWM(url) {
    return await withTtlCache(`tt:${url}`, 300000, async () => {
        const res = await httpClient.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
            timeout: 9000,
            headers: { 'User-Agent': UA }
        });
        if (res.data?.code === 0 && res.data?.data) {
            const d = res.data.data;
            let videoUrl = d.play || d.hdplay || d.wmplay || null;
            if (videoUrl && videoUrl.startsWith('/')) videoUrl = `https://www.tikwm.com${videoUrl}`;
            return {
                videoUrl,
                images: Array.isArray(d.images) ? d.images : null,
                audioUrl: d.music || d.music_info?.play || null,
                title: d.title || 'TikTok Video',
                author: d.author?.nickname || 'TikTok'
            };
        }
        throw new Error('TikTok media extract nahi ho saki.');
    });
}

async function fetchSocialMedia(url) {
    const servers = [
        'https://all-media-downloader-api.onrender.com',
        'https://all-media-downloader-api-0rts.onrender.com'
    ];
    try {
        return await Promise.any(servers.map(async (base) => {
            const res = await httpClient.get(`${base}/api/download?url=${encodeURIComponent(url)}&api_key=m41nul`, { timeout: 12000 });
            if (res.data?.success && (res.data.video_url || res.data.hd || res.data.sd)) {
                return {
                    url: res.data.hd || res.data.video_url || res.data.sd,
                    title: res.data.title || 'Media Download'
                };
            }
            throw new Error('No media');
        }));
    } catch (_) {
        throw new Error('Social downloader API se media nahi mili.');
    }
}

async function runPlay(ctx) {
    if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}play <song name or YouTube link>*`);
    ctx.react('🎵');
    const r = await resolveYoutubeMedia(ctx.fullArgs, 'audio');
    if (r.thumb) {
        ctx.sock.sendMessage(ctx.from, { image: { url: r.thumb }, caption: `🎵 *${r.title}*\n⏳ ${r.duration || 'Audio'}\n📥 Sending MP3...` }, ctx.quoteOpt).catch(() => {});
    }
    await ctx.sock.sendMessage(ctx.from, { audio: { url: r.url }, mimetype: 'audio/mpeg', fileName: `${r.title.slice(0, 40)}.mp3` }, ctx.quoteOpt);
    ctx.react('✅');
}

async function runVideo(ctx) {
    if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}video <video name or YouTube link>*`);
    await ctx.react('🎬');
    const r = await resolveYoutubeMedia(ctx.fullArgs, 'video');
    await ctx.sock.sendMessage(ctx.from, {
        video: { url: r.url },
        mimetype: 'video/mp4',
        caption: `🎬 *${r.title}*\n⏳ ${r.duration || 'HD'}\n⚡ _MINI BOT MD_`
    }, ctx.quoteOpt);
    await ctx.react('✅');
}

async function runTiktok(ctx, audioOnly = false) {
    const url = ctx.args[0];
    if (!url || !/(tiktok\.com|douyin\.com)/i.test(url)) {
        return ctx.reply(`Usage: *${ctx.prefix}${audioOnly ? 'ttmp3' : 'tiktok'} <tiktok link>*`);
    }
    await ctx.react('⏳');
    const data = await fetchTikWM(url);
    if (audioOnly && data.audioUrl) {
        await ctx.sock.sendMessage(ctx.from, { audio: { url: data.audioUrl }, mimetype: 'audio/mpeg' }, ctx.quoteOpt);
    } else if (data.images?.length) {
        for (const img of data.images.slice(0, 5)) {
            await ctx.sock.sendMessage(ctx.from, { image: { url: img }, caption: data.title }, ctx.quoteOpt);
            await sleep(700);
        }
    } else if (data.videoUrl) {
        await ctx.sock.sendMessage(ctx.from, {
            video: { url: data.videoUrl },
            mimetype: 'video/mp4',
            caption: `🎵 *TikTok:* ${data.title}\n👤 *Author:* ${data.author}`
        }, ctx.quoteOpt);
    }
    await ctx.react('✅');
}

async function runFb(ctx) {
    const url = ctx.args[0];
    if (!url || !/(facebook\.com|fb\.watch|fb\.com)/i.test(url)) return ctx.reply(`Usage: *${ctx.prefix}fb <facebook video link>*`);
    await ctx.react('⏳');
    const res = await fetchSocialMedia(url);
    await ctx.sock.sendMessage(ctx.from, { video: { url: res.url }, mimetype: 'video/mp4', caption: `📘 *Facebook Video:* ${res.title}` }, ctx.quoteOpt);
    await ctx.react('✅');
}

async function runIg(ctx) {
    const url = ctx.args[0];
    if (!url || !/(instagram\.com|instagr\.am)/i.test(url)) return ctx.reply(`Usage: *${ctx.prefix}ig <instagram reel/post link>*`);
    await ctx.react('⏳');
    try {
        const home = await httpClient.get('https://saveinsta.to/en/highlights', { headers: { 'User-Agent': UA }, timeout: 7000 });
        const expMatch = home.data.match(/k_exp\s*=\s*["']([^"']+)["']/);
        const tokenMatch = home.data.match(/k_token\s*=\s*["']([^"']+)["']/);
        if (expMatch && tokenMatch) {
            const params = new URLSearchParams({ k_exp: expMatch[1], k_token: tokenMatch[1], q: url, t: 'media', lang: 'en', v: 'v2' });
            const sr = await httpClient.post('https://saveinsta.to/api/ajaxSearch', params, {
                headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://saveinsta.to', Referer: 'https://saveinsta.to/en/highlights' },
                timeout: 8000
            });
            if (sr.data?.status === 'ok' && sr.data?.data) {
                const $ = getCheerio().load(sr.data.data);
                const dl = $('.download-items__btn a').first().attr('href');
                if (dl) {
                    const isVid = /\.(mp4|mov|webm)/i.test(dl) || $('.download-items__btn a').first().text().toLowerCase().includes('video');
                    await ctx.sock.sendMessage(ctx.from, isVid ? { video: { url: dl }, caption: '📸 *Instagram Video*' } : { image: { url: dl }, caption: '📸 *Instagram Photo*' }, ctx.quoteOpt);
                    return await ctx.react('✅');
                }
            }
        }
    } catch (_) {}
    const fb = await fetchSocialMedia(url);
    await ctx.sock.sendMessage(ctx.from, { video: { url: fb.url }, caption: `📸 *Instagram:* ${fb.title}` }, ctx.quoteOpt);
    await ctx.react('✅');
}

const commands = [
    {
        name: 'dl',
        aliases: ['download', 'down'],
        category: 'downloader',
        desc: 'Universal Auto-Downloader (YT, TT, IG, FB, CapCut, MF, Drive)',
        handler: async (ctx) => {
            const url = ctx.args[0];
            if (!url || !isSafePublicHttpUrl(url)) {
                return ctx.reply(`📥 *UNIVERSAL DOWNLOADER*\nUsage: *${ctx.prefix}dl <valid public link>*\nSupports: YouTube, TikTok, Instagram, Facebook, CapCut, MediaFire, Drive`);
            }
            const l = url.toLowerCase();
            if (l.includes('youtube.com') || l.includes('youtu.be')) return runVideo(ctx);
            if (l.includes('tiktok.com') || l.includes('douyin.com')) return runTiktok(ctx, false);
            if (l.includes('instagram.com') || l.includes('instagr.am')) return runIg(ctx);
            if (l.includes('facebook.com') || l.includes('fb.watch')) return runFb(ctx);
            if (l.includes('capcut.com')) return commands.find((c) => c.name === 'capcut').handler(ctx);
            if (l.includes('mediafire.com')) return commands.find((c) => c.name === 'mf').handler(ctx);
            if (l.includes('drive.google.com')) return commands.find((c) => c.name === 'gdrive').handler(ctx);
            return ctx.reply('❌ Link type pehchana nahi gaya. Specific command try karein: `.tiktok`, `.ig`, `.fb`, `.ytmp4`, `.apk`');
        }
    },
    { name: 'play', aliases: ['song', 'ytmp3', 'mp3'], category: 'downloader', desc: 'YouTube se MP3 song/audio download karein', handler: runPlay },
    { name: 'video', aliases: ['ytmp4', 'yt', 'mp4'], category: 'downloader', desc: 'YouTube se MP4 video download karein', handler: runVideo },
    {
        name: 'yts',
        aliases: ['ytsearch'],
        category: 'downloader',
        desc: 'YouTube par top 5 videos search karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}yts <search topic>*`);
            const vids = await withTtlCache(`yts5:${ctx.fullArgs.toLowerCase()}`, 300000, async () => {
                const res = await getYts()(ctx.fullArgs);
                return (res?.videos || []).slice(0, 5);
            });
            if (!vids.length) return ctx.reply('❌ Koi video nahi mili.');
            const lines = vids.map((v, i) => `${i + 1}. *${v.title}*\n   ⏱️ ${v.timestamp} | 👁️ ${v.views}\n   🔗 ${v.url}`);
            await ctx.reply(`🔎 *YOUTUBE SEARCH (${ctx.fullArgs}):*\n\n${lines.join('\n\n')}`);
        }
    },
    { name: 'tiktok', aliases: ['tt', 'ttdl'], category: 'downloader', desc: 'TikTok video without watermark download karein', handler: (ctx) => runTiktok(ctx, false) },
    { name: 'ttmp3', aliases: ['ttaudio'], category: 'downloader', desc: 'TikTok video ki MP3 audio nikalein', handler: (ctx) => runTiktok(ctx, true) },
    { name: 'ig', aliases: ['instagram', 'insta'], category: 'downloader', desc: 'Instagram Reel / Video / Photo download karein', handler: runIg },
    { name: 'fb', aliases: ['facebook', 'fbdl'], category: 'downloader', desc: 'Facebook Video / Reel HD download karein', handler: runFb },
    {
        name: 'capcut',
        aliases: ['cc'],
        category: 'downloader',
        desc: 'CapCut template video download karein',
        handler: async (ctx) => {
            const url = ctx.args[0];
            if (!url || !url.includes('capcut.com')) return ctx.reply(`Usage: *${ctx.prefix}capcut <capcut link>*`);
            await ctx.react('⏳');
            let vid = null;
            let title = 'CapCut Template';
            const apis = [
                `https://api.ryzendesu.vip/api/downloader/capcut?url=${encodeURIComponent(url)}`,
                `https://backend1.tioo.eu.org/capcut?url=${encodeURIComponent(url)}`
            ];
            try {
                const winner = await Promise.any(apis.map(async (api) => {
                    const res = await httpClient.get(api, { timeout: 9000, headers: { 'User-Agent': UA } });
                    const d = res.data || {};
                    const cand = d.videoUrl || d.originalVideoUrl || d.video_url || d.result?.video || d.data?.url;
                    if (!cand) throw new Error('no video');
                    return { vid: cand, title: d.title || d.result?.title || title };
                }));
                vid = winner.vid;
                title = winner.title;
            } catch (_) {}
            if (!vid) throw new Error('CapCut video nahi mili.');
            await ctx.sock.sendMessage(ctx.from, { video: { url: vid }, caption: `🎬 *CapCut:* ${title}` }, ctx.quoteOpt);
            ctx.react('✅');
        }
    },
    {
        name: 'apk',
        aliases: ['apkdl'],
        category: 'downloader',
        desc: 'Android APK search karke direct bhejein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}apk WhatsApp*`);
            ctx.react('⏳');
            const apkData = await withTtlCache(`apk:${ctx.fullArgs.toLowerCase()}`, 600000, async () => {
                // Tier 1: Aptoide official search JSON API (fast & reliable)
                try {
                    const r = await httpClient.get(`https://ws75.aptoide.com/api/7/apps/search?query=${encodeURIComponent(ctx.fullArgs)}&limit=1`, { timeout: 9000, headers: { 'User-Agent': UA } });
                    const app = r.data?.datalist?.list?.[0];
                    if (app?.file?.path) {
                        return {
                            name: app.name || ctx.fullArgs,
                            package: app.package || 'android',
                            size: formatBytes(app.file.filesize || 0),
                            dllink: app.file.path
                        };
                    }
                } catch (_) {}

                // Tier 2: Race fallback APK APIs
                try {
                    return await Promise.any([
                        `https://api.princetechn.com/api/download/apkdl?apikey=prince&appName=${encodeURIComponent(ctx.fullArgs)}`,
                        `https://bk9.fun/download/apk?q=${encodeURIComponent(ctx.fullArgs)}`
                    ].map(async (ep) => {
                        const r = await httpClient.get(ep, { timeout: 8000 });
                        const d = r.data?.result || r.data?.BK9;
                        if (!d?.dllink) throw new Error('no apk');
                        return d;
                    }));
                } catch (_) {
                    return null;
                }
            });

            if (!apkData?.dllink) return ctx.reply(`❌ APK nahi mili: *${ctx.fullArgs}*`);
            await ctx.sock.sendMessage(ctx.from, {
                document: { url: apkData.dllink },
                mimetype: 'application/vnd.android.package-archive',
                fileName: `${String(apkData.name || ctx.fullArgs).replace(/[^a-zA-Z0-9_-]/g, '_')}.apk`,
                caption: `📱 *App:* ${apkData.name}\n📦 *Pkg:* ${apkData.package || 'android'}\n📏 *Size:* ${apkData.size || 'Unknown'}`
            }, ctx.quoteOpt);
            ctx.react('✅');
        }
    },
    {
        name: 'mf',
        aliases: ['mediafire'],
        category: 'downloader',
        desc: 'MediaFire file link se direct file bhejein',
        handler: async (ctx) => {
            const url = ctx.args[0];
            if (!url || !isSafePublicHttpUrl(url) || !url.includes('mediafire.com')) return ctx.reply(`Usage: *${ctx.prefix}mf <mediafire link>*`);
            ctx.react('⏳');
            const res = await httpClient.get(url, { timeout: 10000, headers: { 'User-Agent': UA } });
            const $ = getCheerio().load(res.data);
            const dl = $('#downloadButton').attr('href');
            const name = $('.dl-info .promo_ss_file_name').text().trim() || 'mediafire_file';
            const size = $('.dl-info .promo_ss_file_size').text().trim() || 'Unknown';
            if (!dl) throw new Error('Direct download link nahi mila.');
            await ctx.sock.sendMessage(ctx.from, { document: { url: dl }, mimetype: 'application/octet-stream', fileName: name, caption: `📁 *MediaFire:* ${name} (${size})` }, ctx.quoteOpt);
            ctx.react('✅');
        }
    },
    {
        name: 'gdrive',
        aliases: ['drive'],
        category: 'downloader',
        desc: 'Public Google Drive link se file download karein',
        handler: async (ctx) => {
            const url = ctx.args[0] || '';
            const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})|id=([a-zA-Z0-9_-]{20,})/);
            const fileId = m?.[1] || m?.[2];
            if (!fileId) return ctx.reply(`Usage: *${ctx.prefix}gdrive <google drive file link>*`);
            ctx.react('⏳');
            const dl = `https://docs.google.com/uc?export=download&id=${fileId}`;
            let fileName = `gdrive_${fileId}`;
            let size = 'Unknown';
            try {
                const head = await httpClient.head(dl, { timeout: 6000, maxRedirects: 5, headers: { 'User-Agent': UA } });
                const disp = head.headers['content-disposition'] || '';
                const fm = disp.match(/filename="?([^"]+)"?/i);
                if (fm) fileName = fm[1];
                if (head.headers['content-length']) size = formatBytes(head.headers['content-length']);
            } catch (_) {}
            await ctx.sock.sendMessage(ctx.from, { document: { url: dl }, mimetype: 'application/octet-stream', fileName, caption: `☁️ *GDrive File:* ${fileName}\n📏 *Size:* ${size}` }, ctx.quoteOpt);
            ctx.react('✅');
        }
    },
    {
        name: 'pin',
        aliases: ['pinterest'],
        category: 'downloader',
        desc: 'Pinterest images search & download (.pin cat | 2)',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}pin cute cat | 2*`);
            const [q, cnt] = ctx.fullArgs.split('|').map((s) => s.trim());
            const amount = Math.min(5, Math.max(1, parseInt(cnt, 10) || 1));
            const items = await withTtlCache(`pin:${q.toLowerCase()}`, 300000, async () => {
                const res = await httpClient.get(`https://apis.davidcyril.name.ng/search/pinterest?text=${encodeURIComponent(q)}&apikey=`, { timeout: 10000 });
                return res.data?.result || [];
            });
            if (!items.length) return ctx.reply('❌ Pinterest par koi image nahi mili.');
            for (const item of items.slice(0, amount)) {
                await ctx.sock.sendMessage(ctx.from, { image: { url: item.image }, caption: `📌 *${q}*` }, ctx.quoteOpt);
                if (amount > 1) await sleep(350);
            }
        }
    },
    {
        name: 'wallpaper',
        aliases: ['wp'],
        category: 'downloader',
        desc: 'HD wallpapers search & send karein',
        handler: async (ctx) => {
            if (!ctx.fullArgs) return ctx.reply(`Usage: *${ctx.prefix}wallpaper dark anime*`);
            ctx.fullArgs = `${ctx.fullArgs} wallpaper | 1`;
            return commands.find((c) => c.name === 'pin').handler(ctx);
        }
    },
    {
        name: 'gitclone',
        aliases: ['gitzip'],
        category: 'downloader',
        desc: 'GitHub repository ZIP download karein',
        handler: async (ctx) => {
            const m = (ctx.args[0] || '').match(/github\.com\/([^/\s]+)\/([^/\s#.]+)/i);
            if (!m) return ctx.reply(`Usage: *${ctx.prefix}gitclone https://github.com/user/repo*`);
            const [, user, repo] = m;
            const zipUrl = `https://api.github.com/repos/${user}/${repo}/zipball`;
            await ctx.sock.sendMessage(ctx.from, { document: { url: zipUrl }, mimetype: 'application/zip', fileName: `${repo}.zip`, caption: `🐙 *GitHub Repo:* ${user}/${repo}` }, ctx.quoteOpt);
        }
    },
    {
        name: 'npm',
        aliases: ['npmjs'],
        category: 'downloader',
        desc: 'NPM package info aur tarball link dekhein',
        handler: async (ctx) => {
            const pkg = ctx.args[0];
            if (!pkg) return ctx.reply(`Usage: *${ctx.prefix}npm axios*`);
            const data = await withTtlCache(`npm:${pkg.toLowerCase()}`, 300000, async () => {
                const res = await httpClient.get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, { timeout: 8000 });
                return res.data;
            });
            const latest = data['dist-tags']?.latest;
            const info = data.versions?.[latest] || {};
            await ctx.reply(
                `📦 *NPM PACKAGE: ${data.name}*\n` +
                `🏷️ *Latest:* ${latest}\n` +
                `📄 *Desc:* ${data.description || 'N/A'}\n` +
                `⚖️ *License:* ${data.license || 'N/A'}\n` +
                `🔗 *Tarball:* ${info.dist?.tarball || 'N/A'}`
            );
        }
    },
    {
        name: 'vv',
        aliases: ['antivo', 'viewonce'],
        category: 'downloader',
        desc: 'Quoted View-Once image/video/audio recover karein',
        handler: async (ctx) => {
            if (!ctx.quotedMsg) return ctx.reply('❌ Kisi View-Once photo/video/voice par reply karke `.vv` bhejein.');
            await ctx.react('🔓');
            const media = await extractMedia(ctx.quotedMsg);
            if (!media) return ctx.reply('❌ View-Once media extract nahi ho saki (shayed client ne path strip kar diya ya expired hai).');
            const caption = `🔓 *Recovered View-Once (${media.mediaType.toUpperCase()})*${media.caption ? `\n📝 ${media.caption}` : ''}`;
            const payload = media.mediaType === 'image'
                ? { image: media.buffer, caption }
                : media.mediaType === 'video'
                    ? { video: media.buffer, caption }
                    : { audio: media.buffer, mimetype: media.mimetype || 'audio/mp4', ptt: media.ptt };
            await ctx.sock.sendMessage(ctx.from, payload, ctx.quoteOpt);
            await ctx.react('✅');
        }
    },
    {
        name: 'autovv',
        aliases: [],
        category: 'downloader',
        desc: 'Auto View-Once forwarding to Self-Chat on/off (Owner)',
        ownerOnly: true,
        handler: async (ctx) => {
            if (!ctx.isOwner) return ctx.reply('🔒 Sirf Bot Owner `.autovv` change kar sakta hai.');
            const sub = (ctx.args[0] || '').toLowerCase();
            if (!['on', 'off'].includes(sub)) return ctx.reply(`🔓 *Auto-VV:* ${configStore.getConfig().autovv ? 'ON' : 'OFF'} (${ctx.prefix}autovv on/off)`);
            configStore.updateConfig({ autovv: sub === 'on' });
            await ctx.reply(`✅ Auto View-Once ab *${sub.toUpperCase()}* hai (Self-Chat par aayega).`);
        }
    },
    {
        name: 'save',
        aliases: ['savestatus', 'steal'],
        category: 'downloader',
        desc: 'Quoted WhatsApp Status/Media ko bot se forward/save karein',
        handler: async (ctx) => {
            if (!ctx.quotedMsg) return ctx.reply('❌ Kisi Status ya media par reply karke `.save` bhejein.');
            const media = await extractMedia(ctx.quotedMsg);
            if (!media) return ctx.reply('❌ Media nahi mili.');
            const payload = media.mediaType === 'image'
                ? { image: media.buffer, caption: media.caption || '💾 Saved Media' }
                : media.mediaType === 'video'
                    ? { video: media.buffer, caption: media.caption || '💾 Saved Video' }
                    : media.mediaType === 'audio'
                        ? { audio: media.buffer, mimetype: media.mimetype || 'audio/mp4' }
                        : { document: media.buffer, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName };
            await ctx.sock.sendMessage(ctx.from, payload, ctx.quoteOpt);
        }
    },
    {
        name: 'getfile',
        aliases: ['fetchfile'],
        category: 'downloader',
        desc: 'Kisi public direct URL se file download karke bhejein',
        handler: async (ctx) => {
            const safeUrl = isSafePublicHttpUrl(ctx.args[0]);
            if (!safeUrl) return ctx.reply(`Usage: *${ctx.prefix}getfile https://example.com/file.pdf*`);
            const head = await httpClient.head(safeUrl, { timeout: 7000, maxRedirects: 5 }).catch(() => null);
            const len = Number(head?.headers?.['content-length'] || 0);
            if (len > 45 * 1024 * 1024) return ctx.reply('❌ File 45 MB se bari hai (WhatsApp/RAM limit).');
            const ct = String(head?.headers?.['content-type'] || 'application/octet-stream').split(';')[0];
            if (ct.startsWith('image/')) return ctx.sock.sendMessage(ctx.from, { image: { url: safeUrl } }, ctx.quoteOpt);
            if (ct.startsWith('video/')) return ctx.sock.sendMessage(ctx.from, { video: { url: safeUrl } }, ctx.quoteOpt);
            const name = decodeURIComponent(safeUrl.split('/').pop().split('?')[0] || 'downloaded_file');
            await ctx.sock.sendMessage(ctx.from, { document: { url: safeUrl }, mimetype: ct, fileName: name }, ctx.quoteOpt);
        }
    }
];

module.exports = commands;
