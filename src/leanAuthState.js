'use strict';

/**
 * SIGMA MD :: Ultra-Lean Multi-File Auth State (Zero Global Mutex Memory Leak)
 * 100% disk-compatible drop-in replacement for Baileys useMultiFileAuthState.
 * Releases file locks immediately when refCount hits 0 so 40 sessions never leak thousands of Mutex objects.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { proto, BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');

function fixFileName(file) {
    return String(file || '').replace(/\//g, '__').replace(/:/g, '-');
}

async function useLeanFileAuthState(folder) {
    await fsp.mkdir(folder, { recursive: true });

    // Per-session ephemeral lock map: entries are deleted immediately once tail settles!
    const activeLocks = new Map();

    const withFileLock = async (filePath, fn) => {
        const prev = activeLocks.get(filePath) || Promise.resolve();
        let releaseCurrent;
        const current = prev.catch(() => {}).then(async () => {
            try {
                return await fn();
            } finally {
                if (activeLocks.get(filePath) === releaseCurrent) {
                    activeLocks.delete(filePath);
                }
            }
        });
        releaseCurrent = current;
        activeLocks.set(filePath, current);
        return current;
    };

    const writeData = (data, file) => {
        const filePath = path.join(folder, fixFileName(file));
        return withFileLock(filePath, async () => {
            await fsp.writeFile(filePath, JSON.stringify(data, BufferJSON.replacer));
        });
    };

    const readData = (file) => {
        const filePath = path.join(folder, fixFileName(file));
        return withFileLock(filePath, async () => {
            try {
                const data = await fsp.readFile(filePath, { encoding: 'utf8' });
                return JSON.parse(data, BufferJSON.reviver);
            } catch (_) {
                return null;
            }
        });
    };

    const removeData = (file) => {
        const filePath = path.join(folder, fixFileName(file));
        return withFileLock(filePath, async () => {
            try {
                await fsp.unlink(filePath);
            } catch (_) {}
        });
    };

    const creds = (await readData('creds.json')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds.json'),
        clearLocks: () => activeLocks.clear()
    };
}

module.exports = { useLeanFileAuthState };
