'use strict';

/**
 * SIGMA MD :: Persistent Runtime Config & Group State Store
 * Syncs smoothly between local JSON (data/bot_config.json) and MongoDB Atlas (if configured).
 */

const path = require('path');
const fs = require('fs-extra');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'bot_config.json');

function normalizeDigits(val) {
    if (!val) return '';
    return String(val).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function resolveBotName(rawVal) {
    const clean = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (!clean || /^mini\s*bot(\s*md)?$/i.test(clean)) {
        return 'SIGMA MD';
    }
    return clean;
}

function resolveNewsletterName(rawVal) {
    const clean = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (!clean || /^mini\s*bot(\s*md)?$/i.test(clean) || /^mr\.?\s*saqib$/i.test(clean)) {
        return 'SIGMA MD';
    }
    return clean;
}

function getDefaultConfig() {
    const envOwner = normalizeDigits(process.env.OWNER_NUMBER || '923438673242');
    return {
        botName: resolveBotName(process.env.BOT_NAME),
        ownerName: process.env.OWNER_NAME || 'MR SAQIB',
        newsletterJid: process.env.NEWSLETTER_JID || process.env.NEWSLETTER_ID || '120363431913895899@newsletter',
        newsletterName: resolveNewsletterName(process.env.CHANNEL_NAME),
        miniPairUrl: process.env.MINI_PAIR_URL || 'https://sigmaminibot.vercel.app',
        mainPairUrl: process.env.MAIN_PAIR_URL || 'https://mrsaqib.me/pair',
        channelCardEnabled: true,
        prefix: '.',
        mode: 'public', // public | private | self
        owners: envOwner ? [envOwner] : [],
        banned: [],
        autoread: false,
        autoviewStatus: false,
        autotyping: false,
        autorecord: false,
        antidelete: false,
        autovv: false,
        autoFollowChannels: [],
        groups: {}
    };
}

let state = getDefaultConfig();
let mongoGetter = null;
let saveTimer = null;

function setMongoGetter(fn) {
    mongoGetter = typeof fn === 'function' ? fn : null;
}

function mergeWithDefaults(raw) {
    const def = getDefaultConfig();
    const envOwner = normalizeDigits(process.env.OWNER_NUMBER || '923438673242');
    const ownersSet = new Set([
        ...(Array.isArray(raw?.owners) ? raw.owners.map(normalizeDigits) : []),
        ...(envOwner ? [envOwner] : [])
    ].filter(Boolean));

    return {
        botName: resolveBotName(raw?.botName) || def.botName,
        ownerName: (typeof raw?.ownerName === 'string' && raw.ownerName.trim()) ? raw.ownerName.trim() : def.ownerName,
        newsletterJid: (typeof raw?.newsletterJid === 'string' && raw.newsletterJid.endsWith('@newsletter')) ? raw.newsletterJid.trim() : def.newsletterJid,
        newsletterName: resolveNewsletterName(raw?.newsletterName) || def.newsletterName,
        miniPairUrl: (typeof raw?.miniPairUrl === 'string' && /^https?:\/\//i.test(raw.miniPairUrl.trim())) ? raw.miniPairUrl.trim() : def.miniPairUrl,
        mainPairUrl: (typeof raw?.mainPairUrl === 'string' && /^https?:\/\//i.test(raw.mainPairUrl.trim())) ? raw.mainPairUrl.trim() : def.mainPairUrl,
        channelCardEnabled: raw?.channelCardEnabled === undefined ? def.channelCardEnabled : Boolean(raw.channelCardEnabled),
        prefix: (typeof raw?.prefix === 'string' && raw.prefix.length > 0 && raw.prefix.length <= 3) ? raw.prefix : def.prefix,
        mode: ['public', 'private', 'self'].includes(raw?.mode) ? raw.mode : def.mode,
        owners: Array.from(ownersSet),
        banned: Array.isArray(raw?.banned) ? Array.from(new Set(raw.banned.map(normalizeDigits).filter(Boolean))) : [],
        autoread: Boolean(raw?.autoread),
        autoviewStatus: Boolean(raw?.autoviewStatus),
        autotyping: Boolean(raw?.autotyping),
        autorecord: Boolean(raw?.autorecord),
        antidelete: Boolean(raw?.antidelete),
        autovv: Boolean(raw?.autovv),
        autoFollowChannels: Array.isArray(raw?.autoFollowChannels) ? raw.autoFollowChannels : [],
        groups: (raw?.groups && typeof raw.groups === 'object') ? raw.groups : {}
    };
}

async function loadConfig(db = null) {
    await fs.ensureDir(DATA_DIR);
    let loaded = null;

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            loaded = await fs.readJson(CONFIG_FILE);
        } catch (_) {}
    }

    const database = db || (mongoGetter ? await mongoGetter().catch(() => null) : null);
    if (database) {
        try {
            const doc = await database.collection('mini_bot_config').findOne({ _id: 'config' });
            if (doc && doc.payload) {
                loaded = doc.payload;
            }
        } catch (_) {}
    }

    state = mergeWithDefaults(loaded || {});
    try {
        await fs.writeJson(CONFIG_FILE, state, { spaces: 2 });
    } catch (_) {}
    return state;
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await fs.ensureDir(DATA_DIR);
            await fs.writeJson(CONFIG_FILE, state, { spaces: 2 });
        } catch (_) {}

        if (mongoGetter) {
            try {
                const db = await mongoGetter();
                if (db) {
                    await db.collection('mini_bot_config').updateOne(
                        { _id: 'config' },
                        { $set: { _id: 'config', payload: state, updatedAt: Date.now() } },
                        { upsert: true }
                    );
                }
            } catch (_) {}
        }
    }, 800);
}

function getConfig() {
    return state;
}

function updateConfig(patch) {
    Object.assign(state, patch);
    scheduleSave();
    return state;
}

function isOwnerDigits(digits) {
    const clean = normalizeDigits(digits);
    if (!clean) return false;
    return state.owners.includes(clean);
}

function addOwner(digits) {
    const clean = normalizeDigits(digits);
    if (!clean) return false;
    if (!state.owners.includes(clean)) {
        state.owners.push(clean);
        scheduleSave();
        return true;
    }
    return false;
}

function removeOwner(digits) {
    const clean = normalizeDigits(digits);
    const primary = normalizeDigits(process.env.OWNER_NUMBER || '923438673242');
    if (!clean || clean === primary) return false;
    const before = state.owners.length;
    state.owners = state.owners.filter(d => d !== clean);
    if (state.owners.length !== before) {
        scheduleSave();
        return true;
    }
    return false;
}

function isBannedDigits(digits) {
    const clean = normalizeDigits(digits);
    if (!clean || isOwnerDigits(clean)) return false;
    return state.banned.includes(clean);
}

function banUser(digits) {
    const clean = normalizeDigits(digits);
    if (!clean || isOwnerDigits(clean)) return false;
    if (!state.banned.includes(clean)) {
        state.banned.push(clean);
        scheduleSave();
        return true;
    }
    return false;
}

function unbanUser(digits) {
    const clean = normalizeDigits(digits);
    const before = state.banned.length;
    state.banned = state.banned.filter(d => d !== clean);
    if (state.banned.length !== before) {
        scheduleSave();
        return true;
    }
    return false;
}

function getGroupSettings(groupJid) {
    if (!groupJid) return { antilink: false, welcome: false, goodbye: false, welcomeText: '', goodbyeText: '', warns: {} };
    if (!state.groups[groupJid]) {
        state.groups[groupJid] = {
            antilink: false,
            welcome: false,
            goodbye: false,
            welcomeText: '',
            goodbyeText: '',
            warns: {}
        };
    }
    return state.groups[groupJid];
}

function updateGroupSettings(groupJid, patch) {
    const gs = getGroupSettings(groupJid);
    Object.assign(gs, patch);
    scheduleSave();
    return gs;
}

function addWarning(groupJid, digits) {
    const clean = normalizeDigits(digits);
    if (!clean) return 0;
    const gs = getGroupSettings(groupJid);
    if (!gs.warns || typeof gs.warns !== 'object') gs.warns = {};
    gs.warns[clean] = (gs.warns[clean] || 0) + 1;
    scheduleSave();
    return gs.warns[clean];
}

function resetWarnings(groupJid, digits) {
    const clean = normalizeDigits(digits);
    const gs = getGroupSettings(groupJid);
    if (gs.warns && gs.warns[clean]) {
        delete gs.warns[clean];
        scheduleSave();
        return true;
    }
    return false;
}

module.exports = {
    normalizeDigits,
    setMongoGetter,
    loadConfig,
    getConfig,
    updateConfig,
    scheduleSave,
    isOwnerDigits,
    addOwner,
    removeOwner,
    isBannedDigits,
    banUser,
    unbanUser,
    getGroupSettings,
    updateGroupSettings,
    addWarning,
    resetWarnings
};
