'use strict';

/**
 * ============================================================================
 * SIGMA MINI WORKER :: ULTRA-LOW-RAM MULTI-TENANT & PLATFORM CONTROL ENGINE
 * ============================================================================
 * - Hosts up to 40 concurrent WhatsApp sessions per Heroku worker dyno
 * - Resolves per-session creator branding (Bot Name, Owner, ImageKit Pic, Channel)
 * - Enforces Platform Master Owners (923438673242) + Mandatory .afc / .ajg / .arc
 * - Reports live worker capacity/RAM heartbeats & triggers referral verification
 *   STRICTLY on Baileys connection === 'open'
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const configStore = require('./configStore');
const { httpClient, isSafePublicHttpUrl } = require('./mediaHelper');

// PBKDF2 + AES-256-GCM phone decryption matching Next.js SaaS Portal (`src/lib/cryptoPhone.ts`)
const PHONE_PBKDF2_ITERATIONS = 100000;
const PHONE_CRYPTO_SALT = (process.env.PHONE_CRYPTO_SALT || 'sigma_saas_phone_kdf_salt_2026').trim();
const PHONE_CRYPTO_SECRET = (process.env.PHONE_CRYPTO_SECRET || process.env.CLUSTER_SECRET || 'saqib_cluster_secure_mesh_2026').trim();
let cachedPhoneAesKey = null;

function getPhoneAesKey() {
    if (cachedPhoneAesKey) return cachedPhoneAesKey;
    const derived = crypto.pbkdf2Sync(PHONE_CRYPTO_SECRET, PHONE_CRYPTO_SALT, PHONE_PBKDF2_ITERATIONS, 64, 'sha256');
    cachedPhoneAesKey = derived.subarray(0, 32);
    return cachedPhoneAesKey;
}

function decryptPhone(storedValue) {
    const val = String(storedValue || '').trim();
    if (!val) return '';
    if (!val.startsWith('enc:v1:')) {
        return configStore.normalizeDigits(val);
    }
    try {
        const parts = val.split(':');
        if (parts.length < 5) return '';
        const iv = Buffer.from(parts[2], 'hex');
        const authTag = Buffer.from(parts[3], 'hex');
        const cipherText = parts[4];
        const decipher = crypto.createDecipheriv('aes-256-gcm', getPhoneAesKey(), iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(cipherText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return configStore.normalizeDigits(decrypted);
    } catch (_) {
        return '';
    }
}

const TENANT_STATE_FILE = path.join(__dirname, '..', 'data', 'tenant_sessions.json');
const PORTAL_URL = (process.env.PORTAL_URL || process.env.NEXT_PUBLIC_PORTAL_URL || 'https://sigmamini.vercel.app').trim().replace(/\/+$/, '');
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CLUSTER_SECRET = process.env.CLUSTER_SECRET || 'saqib_cluster_secure_mesh_2026';

const MAX_SESSIONS = Math.max(1, parseInt(process.env.MAX_SESSIONS || '40', 10) || 40);
const RAM_SOFT_LIMIT_MB = Math.max(256, parseInt(process.env.RAM_SOFT_LIMIT_MB || '465', 10) || 465);

// In-memory maps bounded to stay ultra-lightweight inside Heroku 512MB dynos
const sessionMetaMap = new Map(); // phone -> { creatorId, pendingReferral, tenantConfig, toggles, updatedAt }
const creatorCache = new Map();   // creatorId -> { ts, config }
const imageLruCache = new Map();  // safeImageUrl -> { ts, buf }

let platformControls = {
    masterOwners: ['923438673242'],
    mandatoryAfc: [],
    mandatoryArc: {},
    mandatoryAjg: [],
    fetchedAt: 0
};

function capMap(map, max) {
    while (map.size > max) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
    }
}

function loadSessionMetaDisk() {
    try {
        if (!fs.existsSync(TENANT_STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(TENANT_STATE_FILE, 'utf8'));
        if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw)) {
                if (v && typeof v === 'object') sessionMetaMap.set(k, v);
            }
        }
    } catch (_) {}
}

let diskSaveTimer = null;
function scheduleSessionMetaDiskSave() {
    if (diskSaveTimer) return;
    diskSaveTimer = setTimeout(() => {
        diskSaveTimer = null;
        try {
            fs.mkdirSync(path.dirname(TENANT_STATE_FILE), { recursive: true });
            const obj = Object.fromEntries(sessionMetaMap.entries());
            fs.writeFileSync(TENANT_STATE_FILE, JSON.stringify(obj, null, 2));
        } catch (_) {}
    }, 1000);
    diskSaveTimer.unref?.();
}

loadSessionMetaDisk();

function getWorkerId() {
    return (process.env.WORKER_ID || process.env.HEROKU_APP_NAME || 'mini-1').trim().slice(0, 48);
}

function normalizeTenantConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const botName = String(raw.botName || raw.bot_name || 'SIGMA MD').trim().slice(0, 48) || 'SIGMA MD';
    const ownerName = String(raw.ownerName || raw.owner_name || 'MR SAQIB').trim().slice(0, 48) || 'MR SAQIB';
    const rawOwnerNum = raw.ownerNumber || raw.owner_number || '';
    return {
        creatorId: raw.creatorId || raw.id || null,
        username: String(raw.username || '').trim().toLowerCase(),
        botName,
        ownerName,
        ownerNumber: decryptPhone(rawOwnerNum),
        menuPicUrl: String(raw.menuPicUrl || raw.menu_pic_url || '').trim(),
        channelLink: String(raw.channelLink || raw.channel_link || '').trim(),
        channelJid: String(raw.channelJid || raw.channel_jid || '').trim(),
        channelName: botName
    };
}

function registerSessionMeta(phone, info = {}) {
    const cleanPhone = configStore.normalizeDigits(phone);
    if (!cleanPhone) return null;
    const prev = sessionMetaMap.get(cleanPhone) || {};
    const hasCreatorField = Object.prototype.hasOwnProperty.call(info, 'creatorId');
    const hasTenantField = Object.prototype.hasOwnProperty.call(info, 'tenantConfig');
    const tenantCfg = hasTenantField
        ? (info.tenantConfig ? normalizeTenantConfig(info.tenantConfig) : null)
        : (prev.tenantConfig || null);
    const creatorId = hasCreatorField
        ? (info.creatorId || tenantCfg?.creatorId || null)
        : (tenantCfg?.creatorId || prev.creatorId || null);
    const next = {
        creatorId,
        pendingReferral: info.pendingReferral !== undefined ? info.pendingReferral : (prev.pendingReferral || null),
        tenantConfig: tenantCfg,
        updatedAt: Date.now()
    };
    if (tenantCfg?.creatorId) {
        creatorCache.set(tenantCfg.creatorId, { ts: Date.now(), config: tenantCfg });
        capMap(creatorCache, 200);
    }
    sessionMetaMap.set(cleanPhone, next);
    capMap(sessionMetaMap, 120);
    scheduleSessionMetaDiskSave();
    return next;
}

function clearPendingReferral(phone) {
    const cleanPhone = configStore.normalizeDigits(phone);
    const prev = sessionMetaMap.get(cleanPhone);
    if (prev && prev.pendingReferral) {
        prev.pendingReferral = null;
        prev.updatedAt = Date.now();
        scheduleSessionMetaDiskSave();
    }
}

function removeSessionMeta(phone) {
    const cleanPhone = configStore.normalizeDigits(phone);
    if (!cleanPhone) return;
    sessionMetaMap.delete(cleanPhone);
    scheduleSessionMetaDiskSave();
}

function getSessionMeta(phone) {
    const cleanPhone = configStore.normalizeDigits(phone);
    return sessionMetaMap.get(cleanPhone) || sessionMetaMap.get(String(phone || '')) || null;
}

function applyCreatorBrandingToSessions(creatorId, norm) {
    if (!norm) return;
    if (creatorId) {
        creatorCache.set(creatorId, { ts: Date.now(), config: norm });
        capMap(creatorCache, 200);
    }
    for (const meta of sessionMetaMap.values()) {
        const sameCreator = creatorId && meta.creatorId === creatorId;
        const sameUsername = norm.username && meta.tenantConfig?.username === norm.username;
        if (sameCreator || sameUsername) {
            meta.creatorId = creatorId || meta.creatorId || norm.creatorId || null;
            meta.tenantConfig = {
                ...norm,
                creatorId: creatorId || norm.creatorId || meta.creatorId || null,
                ownerNumber: norm.ownerNumber || meta.tenantConfig?.ownerNumber || '',
                channelJid: norm.channelJid || meta.tenantConfig?.channelJid || ''
            };
            meta.updatedAt = Date.now();
        }
    }
    scheduleSessionMetaDiskSave();
}

async function fetchCreatorConfigFromPortal(username, fallbackMeta = null) {
    const cleanUser = String(username || '').trim().toLowerCase();
    if (!PORTAL_URL || !cleanUser) return null;
    try {
        const res = await httpClient.get(
            `${PORTAL_URL}/api/creators/${encodeURIComponent(cleanUser)}`,
            { timeout: 4500 }
        );
        const creator = res.data?.creator;
        if (res.data?.success && creator) {
            const norm = normalizeTenantConfig({
                ...fallbackMeta,
                ...creator,
                creatorId: fallbackMeta?.creatorId || creator.id || null,
                ownerNumber: creator.owner_number || fallbackMeta?.ownerNumber || ''
            });
            applyCreatorBrandingToSessions(norm.creatorId, norm);
            return norm;
        }
    } catch (_) {}
    return null;
}

async function fetchCreatorConfigFromSupabase(creatorId, fallbackMeta = null) {
    if (!creatorId) return null;
    const hit = creatorCache.get(creatorId);
    if (hit && Date.now() - hit.ts < 180000) return hit.config;

    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
            const res = await httpClient.get(
                `${SUPABASE_URL}/rest/v1/creators?id=eq.${encodeURIComponent(creatorId)}&select=id,username,bot_name,owner_name,owner_number,menu_pic_url,channel_link,channel_jid,channel_name&limit=1`,
                {
                    timeout: 4500,
                    headers: {
                        apikey: SUPABASE_SERVICE_KEY,
                        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
                    }
                }
            );
            const row = Array.isArray(res.data) ? res.data[0] : null;
            if (row) {
                const norm = normalizeTenantConfig(row);
                applyCreatorBrandingToSessions(creatorId, norm);
                return norm;
            }
        } catch (_) {}
    }

    const usernameHint = fallbackMeta?.username ||
        Array.from(sessionMetaMap.values()).find((m) => m.creatorId === creatorId)?.tenantConfig?.username || '';
    if (usernameHint) {
        return fetchCreatorConfigFromPortal(usernameHint, { ...(fallbackMeta || {}), creatorId });
    }
    return null;
}

async function refreshTenantConfig(creatorId, directTenantConfig = null) {
    if (directTenantConfig && typeof directTenantConfig === 'object') {
        const norm = normalizeTenantConfig({ ...directTenantConfig, creatorId: creatorId || directTenantConfig.creatorId });
        applyCreatorBrandingToSessions(norm.creatorId || creatorId, norm);
        return norm;
    }
    if (!creatorId) return null;
    creatorCache.delete(creatorId);
    return fetchCreatorConfigFromSupabase(creatorId);
}

async function syncPlatformControls() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return platformControls;
    try {
        const res = await httpClient.get(
            `${SUPABASE_URL}/rest/v1/platform_controls?id=eq.global&limit=1`,
            {
                timeout: 5000,
                headers: {
                    apikey: SUPABASE_SERVICE_KEY,
                    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
                }
            }
        );
        const row = Array.isArray(res.data) ? res.data[0] : null;
        if (row) {
            platformControls = {
                masterOwners: Array.isArray(row.master_owners) && row.master_owners.length
                    ? row.master_owners.map((d) => configStore.normalizeDigits(d)).filter(Boolean)
                    : ['923438673242'],
                mandatoryAfc: Array.isArray(row.mandatory_afc_channels) ? row.mandatory_afc_channels : [],
                mandatoryArc: (row.mandatory_arc_channels && typeof row.mandatory_arc_channels === 'object') ? row.mandatory_arc_channels : {},
                mandatoryAjg: Array.isArray(row.mandatory_ajg_groups) ? row.mandatory_ajg_groups : [],
                fetchedAt: Date.now()
            };
        }
    } catch (_) {}
    return platformControls;
}

function getMasterOwnerSet() {
    const cfg = configStore.getConfig();
    const out = new Set(['923438673242']);
    const envMaster = String(process.env.MASTER_OWNER_NUMBERS || process.env.OWNER_NUMBER || '').split(/[\s,]+/);
    for (const d of [...envMaster, ...(cfg.owners || []), ...(platformControls.masterOwners || [])]) {
        const clean = configStore.normalizeDigits(d);
        if (clean.length >= 10) out.add(clean);
    }
    return out;
}

function isMasterOwner(digits) {
    const clean = configStore.normalizeDigits(digits);
    return Boolean(clean && getMasterOwnerSet().has(clean));
}

function setSessionToggle(phone, patch = {}) {
    const cleanPhone = configStore.normalizeDigits(phone);
    if (!cleanPhone || !patch || typeof patch !== 'object') return null;
    const prev = sessionMetaMap.get(cleanPhone) || { creatorId: null, tenantConfig: null };
    prev.toggles = { ...(prev.toggles || {}), ...patch };
    prev.updatedAt = Date.now();
    sessionMetaMap.set(cleanPhone, prev);
    capMap(sessionMetaMap, 120);
    scheduleSessionMetaDiskSave();
    return prev.toggles;
}

function resolveSessionEffectiveConfig(sessionPhone) {
    const globalCfg = configStore.getConfig();
    const meta = getSessionMeta(sessionPhone);
    const t = meta?.tenantConfig;
    const localToggles = (meta?.toggles && typeof meta.toggles === 'object') ? meta.toggles : {};

    if (!t) {
        return {
            ...globalCfg,
            ...localToggles,
            creatorId: null,
            menuPicUrl: '',
            newsletterName: globalCfg.botName || 'SIGMA MD',
            channelCardEnabled: globalCfg.channelCardEnabled !== false && Boolean(globalCfg.newsletterJid)
        };
    }

    const newsletterJid = t.channelJid && /^\d+@newsletter$/.test(t.channelJid)
        ? t.channelJid
        : globalCfg.newsletterJid;
    // Public owner display for tenant bots shows ONLY that creator's own owner number (master remains silent via isMasterOwner)
    const cleanBotDigits = configStore.normalizeDigits(sessionPhone);
    const owners = t.ownerNumber
        ? [t.ownerNumber]
        : (cleanBotDigits ? [cleanBotDigits] : []);

    return {
        ...globalCfg,
        ...localToggles,
        creatorId: t.creatorId,
        username: t.username,
        botName: t.botName || globalCfg.botName,
        ownerName: t.ownerName || globalCfg.ownerName,
        owners,
        tenantOwnerNumber: t.ownerNumber || cleanBotDigits || '',
        menuPicUrl: t.menuPicUrl || '',
        channelLink: t.channelLink || '',
        newsletterJid,
        newsletterName: t.botName || globalCfg.botName,
        channelCardEnabled: Boolean(newsletterJid)
    };
}

function isSessionOwner(sessionPhone, senderDigits, botDigits = '') {
    const cleanSender = configStore.normalizeDigits(senderDigits);
    if (!cleanSender) return false;
    if (isMasterOwner(cleanSender)) return true;
    if (botDigits && cleanSender === configStore.normalizeDigits(botDigits)) return true;
    const meta = getSessionMeta(sessionPhone);
    const tenantOwner = configStore.normalizeDigits(meta?.tenantConfig?.ownerNumber);
    return Boolean(tenantOwner && cleanSender === tenantOwner);
}

async function getTenantImageBuffer(menuPicUrl) {
    const url = String(menuPicUrl || '').trim();
    if (!url || !isSafePublicHttpUrl(url)) return null;

    const hit = imageLruCache.get(url);
    if (hit && Date.now() - hit.ts < 30 * 60 * 1000) {
        return hit.buf;
    }

    try {
        const res = await httpClient.get(url, {
            responseType: 'arraybuffer',
            timeout: 7000,
            maxContentLength: 600 * 1024 // strict 600KB RAM guard per cached image
        });
        const buf = Buffer.from(res.data);
        if (buf.length < 100) return null;
        imageLruCache.set(url, { ts: Date.now(), buf });
        capMap(imageLruCache, 15);
        return buf;
    } catch (_) {
        return null;
    }
}

function getPlatformMandatoryChannels() {
    const cfg = configStore.getConfig();
    const map = new Map();
    for (const ch of [...(cfg.autoFollowChannels || []), ...(platformControls.mandatoryAfc || [])]) {
        if (ch?.jid && /^\d+@newsletter$/.test(ch.jid)) {
            map.set(ch.jid, ch);
        }
    }
    return Array.from(map.values());
}

function getPlatformMandatoryGroups() {
    const cfg = configStore.getConfig();
    const map = new Map();
    for (const g of [...(cfg.autoJoinGroups || []), ...(platformControls.mandatoryAjg || [])]) {
        if (g?.code) map.set(g.code, g);
    }
    return Array.from(map.values());
}

function getPlatformMandatoryArcMap() {
    const cfg = configStore.getConfig();
    if (cfg.arcEnabled === false) return {};
    const blocked = cfg.arcBlocked || {};
    const combined = {
        ...(platformControls.mandatoryArc || {}),
        ...(cfg.arcChannels || {})
    };
    const filtered = {};
    for (const [k, conf] of Object.entries(combined)) {
        const jid = conf?.jid || k;
        if (!conf || blocked[k] || blocked[jid]) continue;
        filtered[k] = conf;
    }
    return filtered;
}

async function notifyPortalReferralVerified({ phone, refCode, source = 'mini', workerNodeId = null, creatorId = null }) {
    if (!PORTAL_URL || !phone) return false;
    try {
        const res = await httpClient.post(
            `${PORTAL_URL}/api/internal/referral-verified`,
            {
                secret: CLUSTER_SECRET,
                phone: configStore.normalizeDigits(phone),
                refCode: refCode || null,
                source,
                workerNodeId: workerNodeId || getWorkerId(),
                creatorId
            },
            {
                timeout: 6000,
                headers: {
                    'Content-Type': 'application/json',
                    'x-cluster-secret': CLUSTER_SECRET
                }
            }
        );
        if (res.data?.success) {
            clearPendingReferral(phone);
            return res.data;
        }
    } catch (_) {}
    return false;
}

async function notifyPortalSessionStatus({ phone, status = 'disconnected', workerNodeId = null }) {
    if (!PORTAL_URL || !phone) return false;
    try {
        await httpClient.post(
            `${PORTAL_URL}/api/internal/session-status`,
            {
                secret: CLUSTER_SECRET,
                phone: configStore.normalizeDigits(phone),
                status,
                workerNodeId: workerNodeId || getWorkerId()
            },
            {
                timeout: 5000,
                headers: {
                    'Content-Type': 'application/json',
                    'x-cluster-secret': CLUSTER_SECRET
                }
            }
        );
        return true;
    } catch (_) {
        return false;
    }
}

async function sendWorkerHeartbeat({ baseUrl, activeSessions, ramUsageMb, acceptingPairs }) {
    if (!PORTAL_URL || !baseUrl) return false;
    try {
        await httpClient.post(
            `${PORTAL_URL}/api/internal/worker-heartbeat`,
            {
                secret: CLUSTER_SECRET,
                workerId: getWorkerId(),
                baseUrl,
                maxSessions: MAX_SESSIONS,
                activeSessions,
                ramUsageMb,
                acceptingPairs
            },
            {
                timeout: 5000,
                headers: {
                    'Content-Type': 'application/json',
                    'x-cluster-secret': CLUSTER_SECRET
                }
            }
        );
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    MAX_SESSIONS,
    RAM_SOFT_LIMIT_MB,
    getWorkerId,
    registerSessionMeta,
    clearPendingReferral,
    removeSessionMeta,
    getSessionMeta,
    fetchCreatorConfigFromSupabase,
    refreshTenantConfig,
    syncPlatformControls,
    isMasterOwner,
    isSessionOwner,
    setSessionToggle,
    decryptPhone,
    resolveSessionEffectiveConfig,
    getTenantImageBuffer,
    getPlatformMandatoryChannels,
    getPlatformMandatoryGroups,
    getPlatformMandatoryArcMap,
    notifyPortalReferralVerified,
    notifyPortalSessionStatus,
    sendWorkerHeartbeat
};
