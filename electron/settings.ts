import {
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { quarantineCorruptFile } from '@electron/utils/quarantineCorruptFile';

const logger = createLogger('settings');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

let settingsCache: ISettingsData | null = null;
let settingsLoadPromise: Promise<ISettingsData> | null = null;
let settingsCacheGeneration = 0;
let settingsMutationQueue: Promise<unknown> = Promise.resolve();

type TSettingsUpdateResult = Partial<ISettingsData> | undefined;
type TSettingsUpdater = (
    settings: ISettingsData,
) => TSettingsUpdateResult | Promise<TSettingsUpdateResult>;

function getStoragePath() {
    return join(app.getPath('userData'), 'settings.json');
}

function cloneSettings(settings: ISettingsData): ISettingsData {
    return {...settings};
}

function parseSettingsPayload(content: string): unknown {
    const parsed: unknown = JSON.parse(content);
    return parsed;
}

function queueSettingsMutation<T>(mutation: () => Promise<T>) {
    const task = settingsMutationQueue.then(() => mutation());
    settingsMutationQueue = task.then(() => undefined, () => undefined);
    return task;
}

async function writeSettingsAtomically(storagePath: string, settings: ISettingsData) {
    const tempPath = makeSiblingTempPath(storagePath);
    await writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');

    try {
        await atomicReplace(tempPath, storagePath);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

async function readSettingsFromStorage(storagePath: string) {
    if (!existsSync(storagePath)) {
        return sanitizeSettings(DEFAULT_SETTINGS);
    }

    let content: string;
    try {
        content = await readFile(storagePath, 'utf-8');
    } catch (err) {
        logger.error(`Failed to read settings: ${getErrorMessage(err)}`);
        return sanitizeSettings(DEFAULT_SETTINGS);
    }

    try {
        return sanitizeSettings(parseSettingsPayload(content));
    } catch (err) {
        logger.error(`Failed to load settings: ${getErrorMessage(err)}`);
        try {
            const quarantinePath = await quarantineCorruptFile(storagePath);
            await writeSettingsAtomically(storagePath, DEFAULT_SETTINGS);
            logger.warn(`Quarantined corrupt settings at ${quarantinePath ?? storagePath}`);
        } catch (recoveryError) {
            logger.error(`Failed to recover corrupt settings: ${getErrorMessage(recoveryError)}`);
        }
        return sanitizeSettings(DEFAULT_SETTINGS);
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

    if (settingsLoadPromise) {
        return cloneSettings(await settingsLoadPromise);
    }

    const generation = settingsCacheGeneration;
    const storagePath = getStoragePath();
    const loadPromise = readSettingsFromStorage(storagePath);
    settingsLoadPromise = loadPromise;
    let parsed: ISettingsData;
    try {
        parsed = await loadPromise;
        if (generation === settingsCacheGeneration) {
            settingsCache = parsed;
        }
    } finally {
        if (settingsLoadPromise === loadPromise) {
            settingsLoadPromise = null;
        }
    }
    if (STARTUP_TRACE_ENABLED) {
        logger.info(`[startup] loadSettings file read complete (+${Date.now() - startedAt}ms)`);
    }
    return cloneSettings(parsed);
}

export function resetSettingsCacheAfterUserDataPathChange() {
    settingsCacheGeneration += 1;
    settingsCache = null;
    settingsLoadPromise = null;
}

export async function updateSettings(
    mutate: TSettingsUpdater,
): Promise<ISettingsData> {
    const storagePath = getStoragePath();
    return queueSettingsMutation(async () => {
        const current = settingsCache
            ? cloneSettings(settingsCache)
            : await loadSettings();
        const workingCopy = cloneSettings(current);
        const mutationResult = await mutate(workingCopy);
        const next = sanitizeSettings(
            isRecord(mutationResult)
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
