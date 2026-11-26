'use strict';

/**
 * SIGMA MD :: Native WhatsApp Sound Sticker Command (.ssound / .stickersound)
 * Zero heavy npm bloat: uses bundled OGG/Opus SFX + zero-ffmpeg Voice Note passthrough,
 * plus automatic system ffmpeg conversion if ffmpeg exists on host.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { extractMedia, httpClient, withTimeout, sleep } = require('../mediaHelper');
const { sendSoundStickerMessage } = require('../soundStickerProto');

const SFX_DIR = path.join(__dirname, '..', '..', 'assets', 'sfx');
const DEFAULT_STICKER_PATH = path.join(SFX_DIR, 'sigma_sticker.webp');
const MAX_AUDIO_BYTES = 920000;
const PENDING_TTL_MS = 5 * 60 * 1000;

const PRESET_LIST = [
    { key: 'sigma', file: 'sigma.ogg', emoji: '🗿', label: 'Sigma Boy Meme' },
    { key: 'malik', file: 'malik.ogg', emoji: '👑', label: 'Malik Viral Voice' },
    { key: 'famofc', file: 'famofc.ogg', emoji: '⚡', label: 'FAM OFC Track' },
    { key: 'bondo', file: 'bondo.ogg', emoji: '🔥', label: 'Bondo Dialogue' },
    { key: 'boom', file: 'boom.ogg', emoji: '💥', label: 'Vine Boom Impact' },
    { key: 'bruh', file: 'bruh.ogg', emoji: '😑', label: 'Bruh Sound' },
    { key: 'fah', file: 'fah.ogg', emoji: '📉', label: 'Fah Drop Horn' },
    { key: 'ding', file: 'ding.ogg', emoji: '🔔', label: 'Bright Notification Ding' },
    { key: 'sad', file: 'sad.ogg', emoji: '🎺', label: 'Sad Trombone' },
    { key: 'pad', file: 'pad.ogg', emoji: '🎧', label: 'Soft Ambient Pad' }
];

const PRESET_ALIASES = {
    faah: 'fah',
    vineboom: 'boom',
    vine: 'boom',
    chime: 'ding',
    bell: 'ding',
    bgm: 'pad',
    ambient: 'pad',
    trombone: 'sad',
    sigh: 'bruh'
};

let _hasSystemFfmpeg = null;
function hasSystemFfmpeg() {
    if (_hasSystemFfmpeg !== null) return _hasSystemFfmpeg;
    try {
        const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2000 });
        _hasSystemFfmpeg = res.status === 0;
    } catch (_) {
        _hasSystemFfmpeg = false;
    }
    return _hasSystemFfmpeg;
}

function runSystemFfmpeg(args, timeoutMs = 35000) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: timeoutMs }, (err, _out, stderr) => {
            if (err) reject(new Error(String(stderr || err.message || 'ffmpeg failed').slice(0, 160)));
            else resolve();
        });
    });
}

async function transcodeToOpusIfPossible(inputBuf, mime = '') {
    // WhatsApp PTT voice notes (.ogg; codecs=opus) already contain a clean OGG Opus stream -> 0ms passthrough!
    const isNativeOggOpus = /^audio\/ogg/i.test(mime) && inputBuf.length <= MAX_AUDIO_BYTES && inputBuf.slice(0, 4).toString('ascii') === 'OggS';
    if (isNativeOggOpus) {
        return inputBuf;
    }

    if (!hasSystemFfmpeg()) {
        throw new Error('MP3/Video ko Opus mein badalne ke liye host par ffmpeg nahi hai. Voice Note par reply karein ya preset use karein (e.g. .ssound sigma, .ssound boom).');
    }

    const tmpDir = os.tmpdir();
    const id = crypto.randomBytes(6).toString('hex');
    const inPath = path.join(tmpDir, `sigma_ss_in_${id}`);
    const outPath = path.join(tmpDir, `sigma_ss_out_${id}.ogg`);
    try {
        await fsp.writeFile(inPath, inputBuf);
        await runSystemFfmpeg([
            '-i', inPath, '-vn', '-map', '0:a:0', '-t', '18',
            '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', outPath
        ]);
        let outBuf = await fsp.readFile(outPath);
        if (outBuf.length > MAX_AUDIO_BYTES) {
            await runSystemFfmpeg([
                '-i', inPath, '-vn', '-map', '0:a:0', '-t', '14',
                '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '20k', '-f', 'ogg', outPath
            ]);
            outBuf = await fsp.readFile(outPath);
        }
        return outBuf;
    } finally {
        await fsp.unlink(inPath).catch(() => {});
        await fsp.unlink(outPath).catch(() => {});
    }
}

async function videoToWebpWithSystemFfmpeg(vidBuf) {
    if (!hasSystemFfmpeg()) {
        throw new Error('Video sticker banane ke liye host par ffmpeg chahiye. Kisi Sticker par reply karke `.ssound sigma` use karein.');
    }
    const tmpDir = os.tmpdir();
    const id = crypto.randomBytes(6).toString('hex');
    const inPath = path.join(tmpDir, `sigma_sv_in_${id}.mp4`);
    const outPath = path.join(tmpDir, `sigma_sv_out_${id}.webp`);
    try {
        await fsp.writeFile(inPath, vidBuf);
        await runSystemFfmpeg([
            '-i', inPath,
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=12,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=00000000',
            '-loop', '0', '-ss', '0', '-t', '10', '-preset', 'default', '-an', '-vsync', '0', outPath
        ]);
        return await fsp.readFile(outPath);
    } finally {
        await fsp.unlink(inPath).catch(() => {});
        await fsp.unlink(outPath).catch(() => {});
    }
}

const pendingPairCache = new Map();

function capSetPending(key, patch) {
    const now = Date.now();
    for (const [k, v] of pendingPairCache.entries()) {
        if (now - v.updatedAt > PENDING_TTL_MS) pendingPairCache.delete(k);
    }
    if (pendingPairCache.size >= 40) {
        const first = pendingPairCache.keys().next().value;
        pendingPairCache.delete(first);
    }
    const next = { ...(pendingPairCache.get(key) || {}), ...patch, updatedAt: now };
    pendingPairCache.set(key, next);
    return next;
}

function resolvePreset(query) {
    const clean = String(query || '').toLowerCase().trim();
    if (!clean) return null;
    let hit = null;
    if (/^\d+$/.test(clean)) {
        const idx = parseInt(clean, 10) - 1;
        if (idx >= 0 && idx < PRESET_LIST.length) hit = PRESET_LIST[idx];
    }
    if (!hit) {
        const mapped = PRESET_ALIASES[clean] || clean;
        hit = PRESET_LIST.find((p) => p.key === mapped) || null;
    }
    if (!hit) return null;
    const fp = path.join(SFX_DIR, hit.file);
    if (!fs.existsSync(fp)) return null;
    return { ...hit, buffer: fs.readFileSync(fp) };
}

function getDefaultStickerBuffer() {
    if (fs.existsSync(DEFAULT_STICKER_PATH)) {
        return fs.readFileSync(DEFAULT_STICKER_PATH);
    }
    return null;
}

function buildUsageGuide(prefix = '.') {
    const presetLines = PRESET_LIST.map((p, i) => `┃ ${i + 1}. ${p.emoji} *${prefix}ssound ${p.key}* — ${p.label}`).join('\n');
    return (
        `╭━━━〔 🔊 *SIGMA MD — STICKER SOUND* 〕━━━┈⊷\n` +
        `┃ Kisi bhi *Sticker* par Sound Effect ya Voice lagayein!\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
        `📌 *KAISE USE KAREIN:*\n` +
        `1️⃣ *Preset Sound on Sticker:* Kisi Sticker par reply karein:\n` +
        `   👉 *${prefix}ssound sigma* | *boom* | *fah* | *malik*\n` +
        `2️⃣ *Apni Voice Note + Sticker:*\n` +
        `   • Voice Note par reply karke *${prefix}ssound* likhein\n` +
        `   • Phir Sticker par reply karke *${prefix}ssound* likhein!\n` +
        `3️⃣ *Direct Test:* Bina reply *${prefix}ssound sigma* bhejein\n` +
        `4️⃣ *Extract Sound:* Sound Sticker par reply *${prefix}ssound get*\n\n` +
        `🎵 *BUILT-IN PRESETS (Instant Zero-Lag):*\n` +
        `╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷\n` +
        `${presetLines}\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷`
    );
}

async function fetchYoutubeAudioIfAvailable(query) {
    if (!hasSystemFfmpeg()) {
        throw new Error('Song ko Sticker Sound mein badalne ke liye host par `ffmpeg` zaroori hai. Built-in presets (e.g. `.ssound sigma`, `.ssound boom`) ya apni Voice Note use karein!');
    }
    const yts = require('yt-search');
    const ytdl = require('ytdl-lite');
    let targetUrl = query;
    if (!/(youtube\.com|youtu\.be)/i.test(targetUrl)) {
        const search = await withTimeout(yts(query), 10000, 'YouTube search');
        if (!search?.videos?.length) throw new Error('Koi YouTube song nahi mila.');
        targetUrl = search.videos[0].url;
    }
    const r = await withTimeout(ytdl.ytmp3(targetUrl), 15000, 'YouTube audio');
    if (!r?.url) throw new Error('Audio stream URL extract nahi ho saka.');
    const res = await httpClient.get(r.url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 15 * 1024 * 1024 });
    return await transcodeToOpusIfPossible(Buffer.from(res.data), 'audio/mpeg');
}

const commands = [
    {
        name: 'ssound',
        aliases: ['stickersound', 'soundsticker', 'stikersound', 'stickeraudio', 'saudio', 'sfxsticker', 'stksound', 'sfx', 'sounds', 'soundstk', 'addsound', 'audiosticker', 'voicesticker'],
        category: 'tools',
        desc: 'Kisi bhi Sticker par Sound Effect ya Voice lagayein (.ssound sigma)',
        handler: async (ctx) => {
            const p = ctx.prefix || '.';
            const lowerArg = ctx.fullArgs.toLowerCase();

            if (['help', 'list', 'presets', 'guide'].includes(lowerArg)) {
                return ctx.reply(buildUsageGuide(p));
            }

            // Extract sound track from an incoming Sound Sticker
            if (['get', 'extract', 'audio', 'tomp3'].includes(lowerArg)) {
                const embeddedAudio = ctx.quotedMsg?.stickerMessage?.audioMessage || ctx.quotedMsg?.audioStickerMessage?.message?.stickerMessage?.audioMessage;
                if (!embeddedAudio?.url) {
                    return ctx.reply(`❌ Kisi *Sound Sticker* par reply karke \`${p}ssound get\` likhein!`);
                }
                ctx.react('🎵');
                const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                const stream = await downloadContentFromMessage(embeddedAudio, 'audio');
                const chunks = [];
                for await (const c of stream) chunks.push(c);
                await ctx.sock.sendMessage(ctx.from, { audio: Buffer.concat(chunks), mimetype: 'audio/ogg; codecs=opus', ptt: false }, ctx.quoteOpt);
                ctx.react('✅');
                return;
            }

            ctx.react('🔊');
            const callerKey = `${ctx.from}:${ctx.senderDigits || 'user'}`;
            const mediaSource = ctx.quotedMsg || ctx.content;
            const media = await extractMedia(mediaSource);
            const presetMatch = ctx.fullArgs ? resolvePreset(lowerArg) : null;

            // Case 1: Replied to Voice Note / Audio
            if (media?.mediaType === 'audio') {
                const oggBuf = await transcodeToOpusIfPossible(media.buffer, media.mimetype);
                const cached = capSetPending(callerKey, { audioBuffer: oggBuf });
                if (cached.stickerBuffer) {
                    pendingPairCache.delete(callerKey);
                    await sendSoundStickerMessage(ctx.sock, ctx.from, {
                        stickerBuffer: cached.stickerBuffer,
                        audioBuffer: oggBuf,
                        emoji: '🎵',
                        quoted: ctx.msg,
                        cacheMessage: ctx.cacheMessage
                    });
                    ctx.react('✅');
                    return;
                }
                return ctx.reply(`✅ *Voice / Audio saved!*\nAb kisi bhi *Sticker* par reply karke *${p}ssound* likhein — Sound Sticker send ho jayega!`);
            }

            // Case 2: Replied to Short Video (with ffmpeg)
            if (media?.mediaType === 'video') {
                const stickerWebp = await videoToWebpWithSystemFfmpeg(media.buffer);
                let audioOgg = null;
                let emoji = '🎬';
                if (presetMatch) {
                    audioOgg = presetMatch.buffer;
                    emoji = presetMatch.emoji;
                } else if (ctx.fullArgs) {
                    audioOgg = await fetchYoutubeAudioIfAvailable(ctx.fullArgs);
                } else {
                    audioOgg = await transcodeToOpusIfPossible(media.buffer, media.mimetype);
                }
                await sendSoundStickerMessage(ctx.sock, ctx.from, {
                    stickerBuffer: stickerWebp,
                    audioBuffer: audioOgg,
                    emoji,
                    quoted: ctx.msg,
                    cacheMessage: ctx.cacheMessage
                });
                ctx.react('✅');
                return;
            }

            // Case 3: Replied to a Sticker
            if (media?.mediaType === 'sticker') {
                let audioBuf = null;
                let emoji = '🎵';
                if (presetMatch) {
                    audioBuf = presetMatch.buffer;
                    emoji = presetMatch.emoji;
                } else if (ctx.fullArgs) {
                    audioBuf = await fetchYoutubeAudioIfAvailable(ctx.fullArgs);
                } else {
                    const pending = pendingPairCache.get(callerKey);
                    if (pending?.audioBuffer && Date.now() - pending.updatedAt <= PENDING_TTL_MS) {
                        audioBuf = pending.audioBuffer;
                        pendingPairCache.delete(callerKey);
                    } else {
                        capSetPending(callerKey, { stickerBuffer: media.buffer });
                        return ctx.reply(`✅ *Sticker saved!*\nAb:\n• Kisi *Voice Note* par reply karke *${p}ssound* likhein,\n• YA likhein: *${p}ssound sigma* | *${p}ssound boom* | *${p}ssound fah*`);
                    }
                }

                await sendSoundStickerMessage(ctx.sock, ctx.from, {
                    stickerBuffer: media.buffer,
                    audioBuffer: audioBuf,
                    emoji,
                    quoted: ctx.msg,
                    cacheMessage: ctx.cacheMessage
                });
                ctx.react('✅');
                return;
            }

            // Case 4: No replied sticker — direct preset `.ssound sigma` uses cached/default SIGMA sticker
            if (presetMatch) {
                const pending = pendingPairCache.get(callerKey);
                const stickerBuf = (pending?.stickerBuffer && Date.now() - pending.updatedAt <= PENDING_TTL_MS)
                    ? pending.stickerBuffer
                    : getDefaultStickerBuffer();
                if (!stickerBuf) return ctx.reply(buildUsageGuide(p));
                if (pending?.stickerBuffer) pendingPairCache.delete(callerKey);

                await sendSoundStickerMessage(ctx.sock, ctx.from, {
                    stickerBuffer: stickerBuf,
                    audioBuffer: presetMatch.buffer,
                    emoji: presetMatch.emoji,
                    quoted: ctx.msg,
                    cacheMessage: ctx.cacheMessage
                });
                ctx.react('✅');
                return;
            }

            if (ctx.fullArgs) {
                const pending = pendingPairCache.get(callerKey);
                const stickerBuf = (pending?.stickerBuffer && Date.now() - pending.updatedAt <= PENDING_TTL_MS)
                    ? pending.stickerBuffer
                    : getDefaultStickerBuffer();
                if (!stickerBuf) return ctx.reply(buildUsageGuide(p));
                const audioOgg = await fetchYoutubeAudioIfAvailable(ctx.fullArgs);
                if (pending?.stickerBuffer) pendingPairCache.delete(callerKey);

                await sendSoundStickerMessage(ctx.sock, ctx.from, {
                    stickerBuffer: stickerBuf,
                    audioBuffer: audioOgg,
                    emoji: '🎵',
                    quoted: ctx.msg,
                    cacheMessage: ctx.cacheMessage
                });
                ctx.react('✅');
                return;
            }

            return ctx.reply(buildUsageGuide(p));
        }
    }
];

void sleep;
module.exports = commands;
