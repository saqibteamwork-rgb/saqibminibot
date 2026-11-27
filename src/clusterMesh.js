'use strict';

/**
 * SIGMA MD :: Scalable Cross-Bot Cluster Mesh Engine
 * ============================================================================
 * Connects Main Bot Cluster (50 servers: Railway + Heroku s1..s50) and
 * Mini Bot Cluster (ready for 40+ scalable Mini Bot servers via env/Mongo/JSON).
 * Supports bi-directional sync: chfollow, chunfollow, chreact, chvote,
 * sync_auto_follow (.afc), sync_channel_arc (.arc), and 40-node discovery.
 * ============================================================================
 */

const configStore = require('./configStore');
const { httpClient, isSafePublicHttpUrl, sleep, withTimeout } = require('./mediaHelper');

const CLUSTER_SECRET = process.env.CLUSTER_SECRET || 'saqib_cluster_secure_mesh_2026';

// 50 Main Bot Cluster Servers (Heroku + Railway Hub)
const MAIN_BOT_URLS = [
    'https://web-production-08da5300.up.railway.app',
    'https://saqib-bot-v1-d3ecc6f0292e.herokuapp.com', 'https://saqib-bot-s2-1cceb03e9698.herokuapp.com',
    'https://saqibbot3-bb2b46aa1cb4.herokuapp.com', 'https://saqibot4-1469f73b3d77.herokuapp.com',
    'https://saqibbot5-5ffa090fe31f.herokuapp.com', 'https://saqibot6-061b6d17645d.herokuapp.com',
    'https://saqibot7-b9d00e67a587.herokuapp.com', 'https://saqibbot8-f10fafc8b934.herokuapp.com',
    'https://saqibbot9-bebb531508e3.herokuapp.com', 'https://saqibot10-d27e9f3ad01e.herokuapp.com',
    'https://saqibbot11-815563078799.herokuapp.com', 'https://saqibbot12-2fb338ff529a.herokuapp.com',
    'https://saqibot13-392b066b37a5.herokuapp.com', 'https://saqibbot14-d84e8d59500a.herokuapp.com',
    'https://saqibbot16-b071c813d801.herokuapp.com', 'https://saqibot17-a471970ef223.herokuapp.com',
    'https://saqibbot18-45854000f60b.herokuapp.com', 'https://saqibbot19-bb306a89a5f4.herokuapp.com',
    'https://saqibbot20-317bb68e4db0.herokuapp.com', 'https://saqibbot21-ac7859f5f0fb.herokuapp.com',
    'https://saqibot21-0b44cf00a75a.herokuapp.com', 'https://saqibbot22-9318c2de0250.herokuapp.com',
    'https://saqibbot23-1f4bec48d0f2.herokuapp.com', 'https://saqibbot25-46c4cf949a77.herokuapp.com',
    'https://saqibot25-0974df36edd8.herokuapp.com', 'https://saqibot26-69a8011cc819.herokuapp.com',
    'https://saqibot27-1c1d295781fa.herokuapp.com', 'https://saqibbot28-658e7de676c8.herokuapp.com',
    'https://saqibot29-94eae3596692.herokuapp.com', 'https://saqibot30-e89854c3fef2.herokuapp.com',
    'https://saqibot32-daa98fd51f65.herokuapp.com', 'https://saqibot33-454998cdc49b.herokuapp.com',
    'https://saqibot34-88b9afd45ae5.herokuapp.com', 'https://saqibot35-b5a65594dc78.herokuapp.com',
    'https://saqibot36-822da6a7cddd.herokuapp.com', 'https://saqibot37-46d3819a472c.herokuapp.com',
    'https://saqibot38-520caade1fd3.herokuapp.com', 'https://saqibot39-6fa296b89e98.herokuapp.com',
    'https://saqibot40-d19a79bf6170.herokuapp.com', 'https://saqibbot41-fd5991fd6038.herokuapp.com',
    'https://saqibbot42-18e1d04afef3.herokuapp.com', 'https://saqibot43-4ac9ae252f6b.herokuapp.com',
    'https://saqibobot44-6379b396e027.herokuapp.com', 'https://saqibot45-4fee2ad8369c.herokuapp.com',
    'https://saqibbt46-3c399938d5a6.herokuapp.com', 'https://saqibot47-6f2e03e874fc.herokuapp.com',
    'https://saqibot48-ac004fb8d44b.herokuapp.com', 'https://saqibot49-e792da7c6864.herokuapp.com',
    'https://saqibot50-d29d71852e9a.herokuapp.com'
];

// Primary seeded Mini Bot servers (scales cleanly to 40+ via MINI_CLUSTER_NODES env & Mongo/configStore)
const DEFAULT_MINI_URLS = [
    'https://sigmaminibot-8fdafb0f00ef.herokuapp.com'
];

let detectedSelfUrl = null;
const recentDispatches = new Map();
const reactedArcPosts = new Set();

function normalizeBaseUrl(raw) {
    const valid = isSafePublicHttpUrl(raw);
    return valid ? valid.replace(/\/+$/, '') : null;
}

function setDetectedSelfUrl(url) {
    const clean = normalizeBaseUrl(url);
    if (!clean || clean === detectedSelfUrl) return false;
    detectedSelfUrl = clean;
    return true;
}

function getSelfUrl() {
    if (detectedSelfUrl) return detectedSelfUrl;
    const envApp = process.env.APP_URL || (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : '');
    return normalizeBaseUrl(envApp);
}

function parseEnvMiniNodes() {
    const raw = String(process.env.MINI_CLUSTER_NODES || process.env.MINI_NODE_URLS || '').trim();
    if (!raw) return [];
    let items = [];
    if (raw.startsWith('[')) {
        try { items = JSON.parse(raw); } catch (_) { items = []; }
    } else {
        items = raw.split(/[\s,;]+/).filter(Boolean);
    }
    return items.map(normalizeBaseUrl).filter(Boolean);
}

function getMiniNodes(includeSelf = true) {
    const cfg = configStore.getConfig();
    const self = getSelfUrl();
    const set = new Set([
        ...DEFAULT_MINI_URLS.map(normalizeBaseUrl),
        ...parseEnvMiniNodes(),
        ...(Array.isArray(cfg.miniClusterNodes) ? cfg.miniClusterNodes.map(normalizeBaseUrl) : [])
    ].filter(Boolean));
    if (self && includeSelf) set.add(self);
    if (!includeSelf && self) set.delete(self);
    return Array.from(set).slice(0, 60);
}

function registerMiniNode(url) {
    const clean = normalizeBaseUrl(url);
    if (!clean) return false;
    const cfg = configStore.getConfig();
    const list = Array.isArray(cfg.miniClusterNodes) ? [...cfg.miniClusterNodes] : [];
    if (!list.includes(clean)) {
        list.push(clean);
        configStore.updateConfig({ miniClusterNodes: list.slice(-50) });
        return true;
    }
    return false;
}

function removeMiniNode(url) {
    const clean = String(url || '').trim().toLowerCase().replace(/\/+$/, '');
    if (!clean) return false;
    const cfg = configStore.getConfig();
    const list = Array.isArray(cfg.miniClusterNodes) ? cfg.miniClusterNodes : [];
    const next = list.filter((u) => !u.toLowerCase().includes(clean));
    if (next.length !== list.length) {
        configStore.updateConfig({ miniClusterNodes: next });
        return true;
    }
    return false;
}

function getAllMeshTargets(includeSelf = false) {
    const self = getSelfUrl();
    const set = new Set([
        ...MAIN_BOT_URLS.map(normalizeBaseUrl),
        ...getMiniNodes(includeSelf)
    ].filter(Boolean));
    if (!includeSelf && self) set.delete(self);
    return Array.from(set);
}

function markDedup(key, ttlMs = 12000) {
    if (!key) return false;
    const now = Date.now();
    for (const [k, ts] of recentDispatches.entries()) {
        if (now - ts > ttlMs) recentDispatches.delete(k);
    }
    if (recentDispatches.has(key)) return true;
    if (recentDispatches.size >= 250) recentDispatches.delete(recentDispatches.keys().next().value);
    recentDispatches.set(key, now);
    return false;
}

async function broadcastToAllClusters(action, payload = {}, options = {}) {
    if (action === 'chreact' || action === 'chvote') {
        const dedupKey = `${action}:${payload?.jid || payload?.code || ''}:${payload?.serverId || ''}:${payload?.optHashHex || ''}`;
        if (markDedup(dedupKey, 12000)) return [];
    }
    const targets = options.miniOnly ? getMiniNodes(false) : getAllMeshTargets(false);
    const timeoutMs = (action === 'chfollow' || action === 'chunfollow' || action === 'chreact' || action === 'chvote') ? 15000 : 8000;
    const self = getSelfUrl() || 'sigmamini';

    const results = await Promise.allSettled(targets.map((baseUrl) =>
        httpClient.post(`${baseUrl}/api/cluster-action`, {
            action,
            fromNode: self,
            secret: CLUSTER_SECRET,
            payload,
            timestamp: Date.now()
        }, {
            timeout: timeoutMs,
            headers: { 'x-cluster-secret': CLUSTER_SECRET, 'Content-Type': 'application/json' }
        }).then((r) => ({ url: baseUrl, ok: true, data: r.data }))
          .catch((e) => ({ url: baseUrl, ok: false, error: e.message }))
    ));
    return results.map((r) => r.value || { ok: false });
}

async function resolveFromClusters(action, payload, isValid) {
    const targets = getAllMeshTargets(false);
    return new Promise((resolve) => {
        let pending = targets.length;
        let done = false;
        if (!pending) return resolve(null);
        for (const baseUrl of targets) {
            httpClient.post(`${baseUrl}/api/cluster-action`, {
                action,
                fromNode: getSelfUrl() || 'sigmamini',
                secret: CLUSTER_SECRET,
                payload,
                timestamp: Date.now()
            }, {
                timeout: 4500,
                headers: { 'x-cluster-secret': CLUSTER_SECRET, 'Content-Type': 'application/json' }
            }).then((res) => {
                if (!done && isValid(res?.data)) {
                    done = true;
                    resolve(res.data);
                }
            }).catch(() => {}).finally(() => {
                pending--;
                if (pending === 0 && !done) resolve(null);
            });
        }
    });
}

const resolvedChannelCache = new Map();

/**
 * Resolves a WhatsApp channel invite code via local open sockets first,
 * falling back across the active Main Bot 49-server cluster even when Mini Bot has 0 paired numbers.
 */
async function resolveChannelViaMainMesh(code, localSocks = []) {
    const cleanCode = String(code || '').trim().replace(/^.*whatsapp\.com\/channel\//i, '').split(/[/?#\s]/)[0];
    if (!cleanCode) return null;

    const cached = resolvedChannelCache.get(cleanCode);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        return cached.data;
    }

    const activeSocks = (Array.isArray(localSocks) ? localSocks : [localSocks])
        .filter((s) => s && s.user && typeof s.newsletterMetadata === 'function');
    for (const s of activeSocks.slice(0, 3)) {
        try {
            const meta = await withTimeout(s.newsletterMetadata('invite', cleanCode), 4500, 'Resolve channel');
            if (meta?.id && /^\d+@newsletter$/.test(meta.id)) {
                const out = {
                    ok: true,
                    jid: meta.id,
                    name: meta.thread_metadata?.name?.text || meta.name || 'WhatsApp Channel',
                    subscribers: meta.thread_metadata?.subscribers_count ?? meta.subscribers ?? null,
                    inviteCode: cleanCode,
                    source: 'mini_local'
                };
                if (resolvedChannelCache.size > 300) resolvedChannelCache.clear();
                resolvedChannelCache.set(cleanCode, { ts: Date.now(), data: out });
                return out;
            }
        } catch (_) {}
    }

    // Parallel race across live Main Bot servers (with noRelay flag to prevent ping-pong loops)
    const mainRes = await new Promise((resolve) => {
        const targets = MAIN_BOT_URLS.filter((u) => !u.includes('railway'));
        let pending = targets.length;
        let done = false;
        if (!pending) return resolve(null);
        for (const baseUrl of targets) {
            httpClient.post(`${baseUrl}/api/cluster-action`, {
                action: 'resolve_channel',
                fromNode: getSelfUrl() || 'sigmamini',
                secret: CLUSTER_SECRET,
                payload: { code: cleanCode, noRelay: true },
                timestamp: Date.now()
            }, {
                timeout: 5500,
                headers: { 'x-cluster-secret': CLUSTER_SECRET, 'Content-Type': 'application/json' }
            }).then((res) => {
                const d = res?.data?.jid ? res.data : (res?.data?.data?.jid ? res.data.data : null);
                if (!done && d?.jid && /^\d+@newsletter$/.test(d.jid)) {
                    done = true;
                    resolve({
                        ok: true,
                        jid: d.jid,
                        name: d.name || 'WhatsApp Channel',
                        subscribers: d.subscribers ?? null,
                        inviteCode: cleanCode,
                        source: `main_bot_relay:${baseUrl.replace(/^https?:\/\//i, '').split('.')[0]}`
                    });
                }
            }).catch(() => {}).finally(() => {
                pending--;
                if (pending === 0 && !done) resolve(null);
            });
        }
    });

    if (mainRes?.jid) {
        if (resolvedChannelCache.size > 300) resolvedChannelCache.clear();
        resolvedChannelCache.set(cleanCode, { ts: Date.now(), data: mainRes });
    }
    return mainRes;
}

async function pickHealthyMainBotNode() {
    const sample = MAIN_BOT_URLS.slice(0, 8);
    const probes = await Promise.all(sample.map(async (url) => {
        try {
            const res = await httpClient.get(`${url}/health`, { timeout: 3500 });
            const d = res.data || {};
            const active = typeof d.activeSessions === 'number' ? d.activeSessions : (d.pairedSessions || 0);
            const max = typeof d.maxSessions === 'number' ? d.maxSessions : 25;
            return { url, active, max, mem: d.memoryUsageMb || 0 };
        } catch (_) {
            return null;
        }
    }));
    const valid = probes.filter(Boolean).sort((a, b) => (a.active - b.active) || (a.mem - b.mem));
    return (valid.find((n) => n.active < n.max) || valid[0])?.url || MAIN_BOT_URLS[0];
}

async function pickAvailableMiniBotNode(allowConnectedFallback = true) {
    const nodes = getMiniNodes(true);
    const probes = await Promise.all(nodes.map(async (url) => {
        try {
            const res = await httpClient.get(`${url}/health`, { timeout: 3500 });
            const d = res.data || {};
            const active = typeof d.activeSessions === 'number' ? d.activeSessions : (d.connected ? 1 : 0);
            const max = typeof d.maxSessions === 'number' ? d.maxSessions : 40;
            const ram = typeof d.ramUsageMb === 'number' ? d.ramUsageMb : 0;
            const accepting = d.acceptingPairs !== undefined ? Boolean(d.acceptingPairs) : (active < max && ram < 465);
            return { url, online: true, active, max, ram, accepting, connected: Boolean(d.connected) };
        } catch (_) {
            return null;
        }
    }));
    const online = probes.filter(Boolean).sort((a, b) => (a.active - b.active) || (a.ram - b.ram));
    const free = online.find((n) => n.accepting && n.active < n.max);
    if (free) return free.url;
    return allowConnectedFallback ? (online[0]?.url || nodes[0] || DEFAULT_MINI_URLS[0]) : null;
}

async function resolveNewsletterJidLocal(sock, jid, code) {
    if (jid && /^\d+@newsletter$/.test(String(jid).trim())) return String(jid).trim();
    const inv = String(code || (jid && String(jid).endsWith('@newsletter') ? String(jid).split('@')[0] : '')).trim();
    if (!inv || !sock || typeof sock.newsletterMetadata !== 'function') return null;
    try {
        const meta = await withTimeout(sock.newsletterMetadata('invite', inv), 4000, 'Resolve channel');
        const id = meta?.id || meta?.jid;
        if (id && /^\d+@newsletter$/.test(id)) return id;
    } catch (_) {}
    return null;
}

async function executeMiniArcReaction(sock, channelJid, serverId, conf) {
    if (!sock || !sock.user || !channelJid || !serverId || !conf || conf.enabled === false) return false;
    const key = `${channelJid}:${serverId}`;
    if (reactedArcPosts.has(key)) return false;
    reactedArcPosts.add(key);
    if (reactedArcPosts.size > 300) {
        reactedArcPosts.delete(reactedArcPosts.values().next().value);
    }

    const emojis = (Array.isArray(conf.emojis) && conf.emojis.length > 0)
        ? conf.emojis
        : (conf.emoji ? [conf.emoji] : ['❤️', '🔥', '👍']);
    const chosen = emojis[Math.floor(Math.random() * emojis.length)] || '❤️';

    if (typeof sock.newsletterReactMessage === 'function') {
        await withTimeout(sock.newsletterReactMessage(channelJid, String(serverId), chosen), 6000, 'Mini ARC react').catch(() => {});
        return true;
    }
    return false;
}

async function syncAllNewsletterSubscriptions(socksInput) {
    const sockList = Array.isArray(socksInput) ? socksInput : (socksInput ? [socksInput] : []);
    const active = sockList.filter((s) => s && s.user && typeof s.subscribeNewsletterUpdates === 'function');
    if (!active.length) return;

    const cfg = configStore.getConfig();
    const jids = new Set();
    for (const ch of (cfg.autoFollowChannels || [])) {
        if (ch?.jid && /^\d+@newsletter$/.test(ch.jid)) jids.add(ch.jid);
    }
    for (const [k, conf] of Object.entries(cfg.arcChannels || {})) {
        const jid = conf?.jid || k;
        if (conf?.enabled !== false && /^\d+@newsletter$/.test(jid)) jids.add(jid);
    }
    for (const sock of active) {
        for (const jid of jids) {
            try {
                await withTimeout(sock.subscribeNewsletterUpdates(jid), 3500).catch(() => {});
                await sleep(120);
            } catch (_) {}
        }
    }
}

async function handleIncomingClusterAction(body, runtime = {}) {
    const { action, secret, payload } = body || {};
    if (!secret || secret !== CLUSTER_SECRET) {
        throw new Error('Unauthorized cluster secret');
    }

    const singleSock = typeof runtime.getSock === 'function' ? runtime.getSock() : runtime.sock;
    const rawSocks = typeof runtime.getAllSocks === 'function' ? runtime.getAllSocks() : (singleSock ? [singleSock] : []);
    const socks = (rawSocks || []).filter((s) => s && s.user);
    const sock = socks[0] || singleSock;
    const nodeLabel = getSelfUrl() || 'sigmamini';

    switch (action) {
        case 'chfollow': {
            const jid = await resolveNewsletterJidLocal(sock, payload?.jid, payload?.code || payload?.input);
            if (!jid) return { nodeId: nodeLabel, ok: false, error: 'Missing channel JID' };
            let okCount = 0;
            for (const s of socks) {
                if (typeof s.newsletterFollow !== 'function') continue;
                try {
                    await withTimeout(s.newsletterFollow(jid), 10000, 'Cluster chfollow');
                    okCount++;
                } catch (e) {
                    if (/409|already|conflict|subscribed/i.test(String(e?.message || e))) okCount++;
                }
                if (typeof s.subscribeNewsletterUpdates === 'function') {
                    await s.subscribeNewsletterUpdates(jid).catch(() => {});
                }
                if (socks.length > 1) await sleep(350);
            }
            return { nodeId: nodeLabel, ok: okCount > 0, sessionsProcessed: socks.length, success: okCount, jid };
        }

        case 'chunfollow': {
            const jid = await resolveNewsletterJidLocal(sock, payload?.jid, payload?.code || payload?.input);
            if (!jid) return { nodeId: nodeLabel, ok: false, error: 'Missing channel JID' };
            let okCount = 0;
            for (const s of socks) {
                if (typeof s.newsletterUnfollow !== 'function') continue;
                await withTimeout(s.newsletterUnfollow(jid), 10000, 'Cluster chunfollow').then(() => { okCount++; }).catch(() => {});
                if (socks.length > 1) await sleep(350);
            }
            return { nodeId: nodeLabel, ok: okCount > 0, sessionsProcessed: socks.length, success: okCount, jid };
        }

        case 'chreact': {
            const { jid, code, serverId, emojiPool, customEmojis, emoji } = payload || {};
            if (!serverId) return { nodeId: nodeLabel, ok: false, error: 'Missing serverId' };
            const targetJid = await resolveNewsletterJidLocal(sock, jid, code);
            if (!targetJid || !socks.length) return { nodeId: nodeLabel, ok: false };
            const pool = (Array.isArray(emojiPool) && emojiPool.length) ? emojiPool : (Array.isArray(customEmojis) && customEmojis.length ? customEmojis : [emoji || '❤️']);
            let reactedCount = 0;
            for (const s of socks) {
                if (typeof s.newsletterReactMessage !== 'function') continue;
                const chosen = pool[Math.floor(Math.random() * pool.length)];
                await withTimeout(s.newsletterReactMessage(targetJid, String(serverId), chosen), 6000, 'Cluster chreact')
                    .then(() => { reactedCount++; })
                    .catch(() => {});
                if (socks.length > 1) await sleep(350);
            }
            return { nodeId: nodeLabel, ok: reactedCount > 0, reactedCount, target: `${targetJid}/${serverId}` };
        }

        case 'chvote': {
            const { jid, code, serverId, optHashHex } = payload || {};
            if (!serverId || !optHashHex || !socks.length) return { nodeId: nodeLabel, ok: false };
            const targetJid = await resolveNewsletterJidLocal(sock, jid, code);
            if (!targetJid) return { nodeId: nodeLabel, ok: false };
            const optHash = Buffer.from(String(optHashHex), 'hex');
            let votedCount = 0;
            for (const s of socks) {
                if (typeof s.query !== 'function') continue;
                const msgId = typeof s.generateMessageTag === 'function' ? s.generateMessageTag() : `${Date.now()}`;
                await withTimeout(s.query({
                    tag: 'message',
                    attrs: { to: targetJid, id: msgId, type: 'poll', server_id: String(serverId) },
                    content: [
                        { tag: 'meta', attrs: { polltype: 'vote' } },
                        { tag: 'votes', attrs: {}, content: [{ tag: 'vote', attrs: {}, content: optHash }] }
                    ]
                }, 4000), 5000, 'Cluster chvote').then(() => { votedCount++; }).catch(() => {});
                if (socks.length > 1) await sleep(350);
            }
            return { nodeId: nodeLabel, ok: votedCount > 0, votedCount, target: `${targetJid}/${serverId}` };
        }

        case 'sync_auto_follow': {
            const cfg = configStore.getConfig();
            let list = [...(cfg.autoFollowChannels || [])];
            const toFollow = [];

            if (payload?.data?.channels && typeof payload.data.channels === 'object') {
                const nextList = [];
                for (const [k, ch] of Object.entries(payload.data.channels)) {
                    const chJid = ch?.jid || k;
                    if (chJid && /^\d+@newsletter$/.test(chJid)) {
                        nextList.push({
                            jid: chJid,
                            name: ch?.name || 'WhatsApp Channel',
                            link: ch?.link || '',
                            code: ch?.code || ''
                        });
                        if (!list.some((prev) => prev.jid === chJid)) toFollow.push(chJid);
                    }
                }
                list = nextList;
            } else if (payload?.action === 'del' && (payload?.jid || payload?.channel?.jid)) {
                const delId = payload.jid || payload.channel.jid;
                list = list.filter((c) => c.jid !== delId);
            } else if (payload?.channel?.jid) {
                if (!list.some((c) => c.jid === payload.channel.jid)) {
                    list.push({
                        jid: payload.channel.jid,
                        name: payload.channel.name || 'WhatsApp Channel',
                        link: payload.channel.link || '',
                        code: payload.channel.code || ''
                    });
                }
                toFollow.push(payload.channel.jid);
            }

            configStore.updateConfig({ autoFollowChannels: list });
            if (socks.length && toFollow.length) {
                for (const s of socks) {
                    for (const jid of toFollow.slice(0, 10)) {
                        await s.newsletterFollow?.(jid).catch(() => {});
                        await s.subscribeNewsletterUpdates?.(jid).catch(() => {});
                        await sleep(250);
                    }
                }
            }
            return { nodeId: nodeLabel, synced: true, count: list.length };
        }

        case 'sync_channel_arc': {
            const cfg = configStore.getConfig();
            let arcMap = { ...(cfg.arcChannels || {}) };

            if (payload?.data?.channels && typeof payload.data.channels === 'object') {
                const rebuilt = {};
                for (const [k, conf] of Object.entries(payload.data.channels)) {
                    if (!conf) continue;
                    const chJid = conf.jid || k;
                    rebuilt[chJid] = {
                        jid: chJid,
                        name: conf.name || 'WhatsApp Channel',
                        link: conf.link || '',
                        invite: conf.invite || '',
                        emojis: Array.isArray(conf.emojis) && conf.emojis.length ? conf.emojis : ['❤️', '🔥', '👍'],
                        enabled: payload.data.enabled === false ? false : (conf.enabled !== false),
                        addedAt: conf.addedAt || Date.now()
                    };
                }
                arcMap = rebuilt;
            } else if (payload?.op === 'del' && payload?.jid) {
                delete arcMap[payload.jid];
            } else if (payload?.op === 'toggle' && payload?.jid && arcMap[payload.jid]) {
                arcMap[payload.jid].enabled = Boolean(payload.enabled);
            } else if (payload?.channel?.jid) {
                arcMap[payload.channel.jid] = {
                    ...payload.channel,
                    enabled: payload.channel.enabled !== false,
                    addedAt: payload.channel.addedAt || Date.now()
                };
            }

            configStore.updateConfig({ arcChannels: arcMap });
            if (socks.length) {
                await syncAllNewsletterSubscriptions(socks).catch(() => {});
            }
            return { nodeId: nodeLabel, synced: true, count: Object.keys(arcMap).length };
        }

        case 'resolve_channel': {
            if (!payload?.code) return { ok: false };
            for (const s of socks) {
                if (!s?.newsletterMetadata) continue;
                try {
                    const meta = await withTimeout(s.newsletterMetadata('invite', payload.code), 5000, 'Resolve channel');
                    if (meta?.id && /^\d+@newsletter$/.test(meta.id)) {
                        return { ok: true, jid: meta.id, name: meta.thread_metadata?.name?.text || meta.name || 'WhatsApp Channel' };
                    }
                } catch (_) {}
            }
            if (!payload?.noRelay && !body?.noRelay) {
                const relayed = await resolveChannelViaMainMesh(payload.code, []);
                if (relayed?.jid) return relayed;
            }
            return { ok: false };
        }

        case 'register_mini_node': {
            const added = registerMiniNode(payload?.url);
            return { nodeId: nodeLabel, ok: true, added, totalMiniNodes: getMiniNodes(true).length };
        }

        default:
            return { nodeId: nodeLabel, ok: false, unknownAction: action };
    }
}

module.exports = {
    CLUSTER_SECRET,
    MAIN_BOT_URLS,
    DEFAULT_MINI_URLS,
    setDetectedSelfUrl,
    getSelfUrl,
    getMiniNodes,
    registerMiniNode,
    removeMiniNode,
    getAllMeshTargets,
    broadcastToAllClusters,
    resolveFromClusters,
    resolveChannelViaMainMesh,
    pickHealthyMainBotNode,
    pickAvailableMiniBotNode,
    executeMiniArcReaction,
    syncAllNewsletterSubscriptions,
    handleIncomingClusterAction
};
