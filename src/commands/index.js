'use strict';

/**
 * SIGMA MD :: Unified Command Registry & Dispatcher
 */

const modules = [
    ...require('./menuAndCore'),
    ...require('./owner'),
    ...require('./group'),
    ...require('./channel'),
    ...require('./downloader'),
    ...require('./tools'),
    ...require('./soundSticker'),
    ...require('./stickersAndAi')
];

const commandMap = new Map();
const aliasMap = new Map();
const byCategory = new Map();

for (const cmd of modules) {
    if (!cmd || !cmd.name || typeof cmd.handler !== 'function') continue;
    const key = cmd.name.toLowerCase();
    commandMap.set(key, cmd);
    aliasMap.set(key, cmd);

    if (Array.isArray(cmd.aliases)) {
        for (const al of cmd.aliases) {
            const ak = String(al).toLowerCase();
            if (ak && !commandMap.has(ak) && !aliasMap.has(ak)) {
                aliasMap.set(ak, cmd);
            }
        }
    }

    const cat = cmd.category || 'core';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(cmd);
}

function findCommand(name) {
    return aliasMap.get(String(name || '').toLowerCase()) || null;
}

function getAllCommands() {
    return Array.from(commandMap.values());
}

function getByCategory(cat) {
    return byCategory.get(cat) || [];
}

function getCategories() {
    return Array.from(byCategory.keys());
}

module.exports = {
    findCommand,
    getAllCommands,
    getByCategory,
    getCategories
};
