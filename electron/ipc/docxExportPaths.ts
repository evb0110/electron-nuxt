import {
    extname,
    resolve,
} from 'path';

const DOCX_WRITE_PATH_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DOCX_WRITE_PATH_MAX_ENTRIES ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 64;
    }
    return Math.min(parsed, 1_024);
})();
const DOCX_WRITE_PATH_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DOCX_WRITE_PATH_TTL_MS ?? `${15 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 15 * 60 * 1000;
    }
    return parsed;
})();
const allowedDocxWritePaths = new Map<string, {
    expiresAt: number;
    senderWebContentsId: number;
}>();

function normalizePath(filePath: string): string {
    return resolve(filePath.trim());
}

export function normalizeDocxPath(filePath: string): string {
    const normalizedPath = normalizePath(filePath);
    if (extname(normalizedPath).toLowerCase() !== '.docx') {
        throw new Error('Invalid file type: only DOCX files are allowed');
    }
    return normalizedPath;
}

function pruneAllowedDocxWritePaths(now = Date.now()) {
    for (const [
        docxPath,
        grant,
    ] of allowedDocxWritePaths.entries()) {
        if (grant.expiresAt <= now) {
            allowedDocxWritePaths.delete(docxPath);
        }
    }

    if (allowedDocxWritePaths.size <= DOCX_WRITE_PATH_MAX_ENTRIES) {
        return;
    }

    const overflowCount = allowedDocxWritePaths.size - DOCX_WRITE_PATH_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const oldestPath = allowedDocxWritePaths.keys().next().value;
        if (typeof oldestPath !== 'string') {
            break;
        }
        allowedDocxWritePaths.delete(oldestPath);
    }
}

export function allowDocxWritePath(filePath: string, senderWebContentsId: number) {
    const normalizedPath = normalizeDocxPath(filePath);
    const now = Date.now();
    pruneAllowedDocxWritePaths(now);
    if (allowedDocxWritePaths.has(normalizedPath)) {
        allowedDocxWritePaths.delete(normalizedPath);
    }
    allowedDocxWritePaths.set(normalizedPath, {
        expiresAt: now + DOCX_WRITE_PATH_TTL_MS,
        senderWebContentsId,
    });
    pruneAllowedDocxWritePaths(now);
}

export function consumeAllowedDocxWritePath(filePath: string, senderWebContentsId: number): boolean {
    const normalizedPath = normalizeDocxPath(filePath);
    const now = Date.now();
    pruneAllowedDocxWritePaths(now);
    const grant = allowedDocxWritePaths.get(normalizedPath);
    if (!grant) {
        return false;
    }
    if (grant.expiresAt <= now) {
        allowedDocxWritePaths.delete(normalizedPath);
        return false;
    }
    if (grant.senderWebContentsId !== senderWebContentsId) {
        return false;
    }
    allowedDocxWritePaths.delete(normalizedPath);
    return true;
}
