import {
    readFile,
    rename,
    rm,
    writeFile,
} from 'fs/promises';
import {
    existsSync,
    readFileSync,
} from 'fs';
import { join } from 'path';
import { app } from 'electron';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('settings');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

let settingsCache: ISettingsData | null = null;
let settingsMutationQueue: Promise<unknown> = Promise.resolve();

function getStoragePath() {
    return join(app.getPath('userData'), 'settings.json');
}

function cloneSettings(settings: ISettingsData): ISettingsData {
    return {...settings};
}

function cacheSettings(raw: Partial<ISettingsData> | null | undefined): ISettingsData {
    settingsCache = sanitizeSettings(raw);
    return cloneSettings(settingsCache);
}

function queueSettingsMutation<T>(mutation: () => Promise<T>) {
    const task = settingsMutationQueue.then(() => mutation());
    settingsMutationQueue = task.then(() => undefined, () => undefined);
    return task;
}

async function writeSettingsAtomically(storagePath: string, settings: ISettingsData) {
    const tempPath = `${storagePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');

    try {
        await rename(tempPath, storagePath);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

async function readSettingsFromStorage(storagePath: string) {
    if (!existsSync(storagePath)) {
        return cacheSettings(DEFAULT_SETTINGS);
    }

    try {
        const content = await readFile(storagePath, 'utf-8');
        return cacheSettings(JSON.parse(content) as Partial<ISettingsData>);
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        return cacheSettings(DEFAULT_SETTINGS);
    }
}

export async function loadSettings(): Promise<ISettingsData> {
    const startedAt = Date.now();
    if (settingsCache) {
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] loadSettings cache hit (+${Date.now() - startedAt}ms)`);
        }
        return cloneSettings(settingsCache);
    }

    const parsed = await readSettingsFromStorage(getStoragePath());
    if (STARTUP_TRACE_ENABLED) {
        logger.info(`[startup] loadSettings file read complete (+${Date.now() - startedAt}ms)`);
    }
    return parsed;
}

export async function saveSettings(settings: ISettingsData): Promise<void> {
    const safeSettings = sanitizeSettings(settings);
    const storagePath = getStoragePath();
    await queueSettingsMutation(async () => {
        try {
            await writeSettingsAtomically(storagePath, safeSettings);
            settingsCache = safeSettings;
        } catch (err) {
            logger.error(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    });
}

export async function updateSettings(
    mutate: (settings: ISettingsData) => unknown | Promise<unknown>,
): Promise<ISettingsData> {
    const storagePath = getStoragePath();
    return queueSettingsMutation(async () => {
        const current = settingsCache
            ? cloneSettings(settingsCache)
            : await readSettingsFromStorage(storagePath);
        const workingCopy = cloneSettings(current);
        const mutationResult = await mutate(workingCopy);
        const next = sanitizeSettings(
            mutationResult && typeof mutationResult === 'object'
                ? {
                    ...workingCopy,
                    ...mutationResult,
                }
                : workingCopy,
        );
        await writeSettingsAtomically(storagePath, next);
        settingsCache = next;
        return cloneSettings(next);
    });
}

function loadSettingsSync(): ISettingsData {
    if (settingsCache) {
        return cloneSettings(settingsCache);
    }

    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        return cacheSettings(DEFAULT_SETTINGS);
    }

    try {
        const content = readFileSync(storagePath, 'utf-8');
        return cacheSettings(JSON.parse(content) as Partial<ISettingsData>);
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        return cacheSettings(DEFAULT_SETTINGS);
    }
}

export function getCurrentLocaleSync() {
    return loadSettingsSync().locale;
}
