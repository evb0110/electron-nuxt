import { realpathSync } from 'fs';
import type { WebContents } from 'electron';
import {
    resolve,
    sep,
} from 'path';
import { createLogger } from '@electron/utils/logger';

declare const __openPathBrand: unique symbol;
export type TOpenPath = string & { readonly [__openPathBrand]: true };

const logger = createLogger('open-path-capabilities');
const allowedOpenPathsByOwner = new Map<number, Set<string>>();
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
        return realpathSync.native(resolve(normalizedPath));
    } catch {
        return null;
    }
}

function pruneAllowedOpenPaths() {
    for (const allowedOpenPaths of allowedOpenPathsByOwner.values()) {
        while (allowedOpenPaths.size > MAX_ALLOWED_OPEN_PATHS) {
            const oldestPath = allowedOpenPaths.values().next().value;
            if (!oldestPath) {
                return;
            }
            allowedOpenPaths.delete(oldestPath);
        }
    }
}

function getAllowedOpenPaths(ownerId: number) {
    let allowedOpenPaths = allowedOpenPathsByOwner.get(ownerId);
    if (!allowedOpenPaths) {
        allowedOpenPaths = new Set<string>();
        allowedOpenPathsByOwner.set(ownerId, allowedOpenPaths);
    }
    return allowedOpenPaths;
}

function getOwnerId(owner: number | WebContents) {
    return typeof owner === 'number' ? owner : owner.id;
}

export function allowOpenPathForWebContents(owner: number | WebContents, filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return null;
    }

    const allowedOpenPaths = getAllowedOpenPaths(getOwnerId(owner));
    allowedOpenPaths.delete(normalizedPath);
    allowedOpenPaths.add(normalizedPath);
    pruneAllowedOpenPaths();
    return normalizedPath as TOpenPath;
}

export function allowOpenPathsForWebContents(owner: number | WebContents, filePaths: string[]) {
    for (const filePath of filePaths) {
        allowOpenPathForWebContents(owner, filePath);
    }
}

export function clearOpenPathsForWebContents(owner: number | WebContents) {
    allowedOpenPathsByOwner.delete(getOwnerId(owner));
}

export function allowOpenPath(filePath: string, owner?: number | WebContents) {
    if (owner !== undefined) {
        return allowOpenPathForWebContents(owner, filePath);
    }

    return allowOpenPathForWebContents(0, filePath);
}

export function allowOpenPaths(filePaths: string[], owner?: number | WebContents) {
    allowOpenPathsForWebContents(owner ?? 0, filePaths);
}

function isAllowedOpenPath(filePath: string, owner?: number | WebContents) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return false;
    }

    return Boolean(allowedOpenPathsByOwner.get(getOwnerId(owner ?? 0))?.has(normalizedPath));
}

export function requireOpenPath(rawPath: string, owner?: number | WebContents): TOpenPath {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        throw new Error('Path not accessible');
    }

    const normalizedPath = normalizeOpenPath(rawPath);
    if (!normalizedPath) {
        throw new Error('Path not accessible');
    }

    if (!isAllowedOpenPath(normalizedPath, owner)) {
        throw new Error(`Path not allowed: ${rawPath}`);
    }

    return normalizedPath as TOpenPath;
}

export function removeAllowedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return;
    }
    for (const allowedOpenPaths of allowedOpenPathsByOwner.values()) {
        allowedOpenPaths.delete(normalizedPath);
    }
}

export function logRejectedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    const displayPath = normalizedPath
        ? normalizedPath.split(sep).slice(-3).join(sep)
        : '<invalid>';
    logger.warn(`Rejected renderer direct-open request without a main-issued capability: ${displayPath}`);
}
