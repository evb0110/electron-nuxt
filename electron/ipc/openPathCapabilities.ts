import type { WebContents } from 'electron';
import { sep } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';

declare const __openPathBrand: unique symbol;
export type TOpenPath = string & { readonly [__openPathBrand]: true };

const logger = createLogger('open-path-capabilities');
interface IOpenPathGrant { expiresAtMs: number; }

const allowedOpenPathsByOwner = new Map<number, Map<string, IOpenPathGrant>>();
const ownerCleanupRegistered = new Set<number>();
const MAX_ALLOWED_OPEN_PATHS = (() => {
    const parsed = Number.parseInt(process.env.EVB_ALLOWED_OPEN_PATHS_MAX ?? '2048', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 2048;
    }
    return Math.min(parsed, 100_000);
})();
const OPEN_PATH_CAPABILITY_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OPEN_PATH_CAPABILITY_TTL_MS ?? `${24 * 60 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 24 * 60 * 60 * 1000;
    }
    return Math.min(parsed, 7 * 24 * 60 * 60 * 1000);
})();

function normalizeOpenPath(filePath: string) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return null;
    }

    return normalizePossiblyEncodedExistingPath(normalizedPath);
}

function pruneAllowedOpenPaths(now = Date.now()) {
    for (const [
        ownerId,
        allowedOpenPaths,
    ] of allowedOpenPathsByOwner.entries()) {
        for (const [
            filePath,
            grant,
        ] of allowedOpenPaths.entries()) {
            if (grant.expiresAtMs <= now) {
                allowedOpenPaths.delete(filePath);
            }
        }

        while (allowedOpenPaths.size > MAX_ALLOWED_OPEN_PATHS) {
            const oldestPath = allowedOpenPaths.keys().next().value;
            if (!oldestPath) {
                return;
            }
            allowedOpenPaths.delete(oldestPath);
        }

        if (allowedOpenPaths.size === 0) {
            allowedOpenPathsByOwner.delete(ownerId);
        }
    }
}

function getAllowedOpenPaths(ownerId: number) {
    let allowedOpenPaths = allowedOpenPathsByOwner.get(ownerId);
    if (!allowedOpenPaths) {
        allowedOpenPaths = new Map<string, IOpenPathGrant>();
        allowedOpenPathsByOwner.set(ownerId, allowedOpenPaths);
    }
    return allowedOpenPaths;
}

function removeAllowedOpenPathsForOwner(ownerId: number) {
    allowedOpenPathsByOwner.delete(ownerId);
    ownerCleanupRegistered.delete(ownerId);
}

function getOwnerId(owner: number | WebContents) {
    if (typeof owner === 'number') {
        return owner;
    }

    return typeof owner.id === 'number' ? owner.id : 0;
}

function registerOwnerCleanup(owner: number | WebContents, ownerId: number) {
    if (typeof owner === 'number' || ownerId === 0 || ownerCleanupRegistered.has(ownerId)) {
        return;
    }

    if (typeof owner.isDestroyed === 'function' && owner.isDestroyed()) {
        removeAllowedOpenPathsForOwner(ownerId);
        return;
    }

    if (typeof owner.once !== 'function') {
        return;
    }

    ownerCleanupRegistered.add(ownerId);
    const cleanup = () => {
        owner.removeListener?.('destroyed', cleanup);
        owner.removeListener?.('render-process-gone', cleanup);
        owner.removeListener?.('did-start-navigation', handleNavigation);
        removeAllowedOpenPathsForOwner(ownerId);
    };
    const handleNavigation = (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup();
        }
    };
    owner.once('destroyed', cleanup);
    owner.once('render-process-gone', cleanup);
    owner.on?.('did-start-navigation', handleNavigation);
}

function isDestroyedOwner(owner: number | WebContents) {
    return typeof owner !== 'number'
        && typeof owner.isDestroyed === 'function'
        && owner.isDestroyed();
}

function allowOpenPathForWebContents(owner: number | WebContents, filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return null;
    }

    if (isDestroyedOwner(owner)) {
        removeAllowedOpenPathsForOwner(getOwnerId(owner));
        return null;
    }

    const ownerId = getOwnerId(owner);
    registerOwnerCleanup(owner, ownerId);
    const allowedOpenPaths = getAllowedOpenPaths(ownerId);
    allowedOpenPaths.delete(normalizedPath);
    allowedOpenPaths.set(normalizedPath, {expiresAtMs: Date.now() + OPEN_PATH_CAPABILITY_TTL_MS});
    pruneAllowedOpenPaths();
    return normalizedPath as TOpenPath;
}

function allowOpenPathsForWebContents(owner: number | WebContents, filePaths: string[]) {
    for (const filePath of filePaths) {
        allowOpenPathForWebContents(owner, filePath);
    }
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

    const ownerId = getOwnerId(owner ?? 0);
    const allowedOpenPaths = allowedOpenPathsByOwner.get(ownerId);
    const grant = allowedOpenPaths?.get(normalizedPath);
    if (!grant) {
        return false;
    }

    if (grant.expiresAtMs <= Date.now()) {
        allowedOpenPaths?.delete(normalizedPath);
        if (allowedOpenPaths?.size === 0) {
            allowedOpenPathsByOwner.delete(ownerId);
        }
        return false;
    }

    return true;
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
