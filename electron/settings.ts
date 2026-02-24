import {
    readFile,
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
} from '@app/shared/settings-sanitizer';
import type { ISettingsData } from '@app/types/shared';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('settings');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

let settingsCache: ISettingsData | null = null;

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

export async function loadSettings(): Promise<ISettingsData> {
    const startedAt = Date.now();
    if (settingsCache) {
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] loadSettings cache hit (+${Date.now() - startedAt}ms)`);
        }
        return cloneSettings(settingsCache);
    }

    const storagePath = getStoragePath();
    if (!existsSync(storagePath)) {
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] loadSettings no file, using defaults (+${Date.now() - startedAt}ms)`);
        }
        return cacheSettings(DEFAULT_SETTINGS);
    }

    try {
        const content = await readFile(storagePath, 'utf-8');
        const parsed = cacheSettings(JSON.parse(content) as Partial<ISettingsData>);
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] loadSettings file read complete (+${Date.now() - startedAt}ms)`);
        }
        return parsed;
    } catch (err) {
        logger.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`);
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] loadSettings failed, using defaults (+${Date.now() - startedAt}ms)`);
        }
        return cacheSettings(DEFAULT_SETTINGS);
    }
}

export async function saveSettings(settings: ISettingsData): Promise<void> {
    const storagePath = getStoragePath();
    const safeSettings = sanitizeSettings(settings);
    try {
        await writeFile(storagePath, JSON.stringify(safeSettings, null, 2), 'utf-8');
        settingsCache = safeSettings;
    } catch (err) {
        logger.error(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
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
