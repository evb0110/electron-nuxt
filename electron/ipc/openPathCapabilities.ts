import {
    resolve,
    sep,
} from 'path';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('open-path-capabilities');
const allowedOpenPaths = new Set<string>();
const MAX_ALLOWED_OPEN_PATHS = (() => {
    const parsed = Number.parseInt(process.env.EVB_ALLOWED_OPEN_PATHS_MAX ?? '2048', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 2048;
    }
    return Math.min(parsed, 100_000);
})();

function normalizeOpenPath(filePath: string) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return null;
    }

    try {
        return resolve(normalizedPath);
    } catch {
        return null;
    }
}

function pruneAllowedOpenPaths() {
    while (allowedOpenPaths.size > MAX_ALLOWED_OPEN_PATHS) {
        const oldestPath = allowedOpenPaths.values().next().value;
        if (!oldestPath) {
            return;
        }
        allowedOpenPaths.delete(oldestPath);
    }
}

export function allowOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return null;
    }

    allowedOpenPaths.delete(normalizedPath);
    allowedOpenPaths.add(normalizedPath);
    pruneAllowedOpenPaths();
    return normalizedPath;
}

export function allowOpenPaths(filePaths: string[]) {
    for (const filePath of filePaths) {
        allowOpenPath(filePath);
    }
}

export function isAllowedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    return Boolean(normalizedPath && allowedOpenPaths.has(normalizedPath));
}

export function removeAllowedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return;
    }
    allowedOpenPaths.delete(normalizedPath);
}

export function logRejectedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    const displayPath = normalizedPath
        ? normalizedPath.split(sep).slice(-3).join(sep)
        : '<invalid>';
    logger.warn(`Rejected renderer direct-open request without a main-issued capability: ${displayPath}`);
}
