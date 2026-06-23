import { realpathSync } from 'fs';
import { resolve } from 'path';
import type { ILogger } from '@electron/utils/createLogger';
import type { IOcrPendingResultFile } from '@electron/ocr/jobManager.types';

interface ICreatePendingResultFileStoreOptions {
    logger: ILogger;
    ttlMs: number;
    removeResultFile: (path: string) => Promise<boolean>;
    canonicalizePath?: (path: string) => string;
}

interface IPendingResultFileOwnershipRegistry { findByPath: (webContentsId: number, pdfPath: string) => IOcrPendingResultFile | null; }

let activeOwnershipRegistry: IPendingResultFileOwnershipRegistry | null = null;

function canonicalizePendingResultPath(pdfPath: string) {
    const resolvedPath = resolve(pdfPath);
    try {
        return realpathSync(resolvedPath);
    } catch {
        return resolvedPath;
    }
}

function normalizePendingResultPath(
    pdfPath: string,
    canonicalizePath: (path: string) => string = canonicalizePendingResultPath,
) {
    const normalizedPath = pdfPath.trim();
    if (!normalizedPath) {
        return '';
    }

    try {
        const canonicalPath = canonicalizePath(normalizedPath).trim();
        return canonicalPath ? resolve(canonicalPath) : resolve(normalizedPath);
    } catch {
        return resolve(normalizedPath);
    }
}

export function findPendingOcrResultFileForPath(webContentsId: number, pdfPath: string) {
    return activeOwnershipRegistry?.findByPath(webContentsId, pdfPath) ?? null;
}

export function createPendingResultFileStore(options: ICreatePendingResultFileStoreOptions) {
    const pendingResultFiles = new Map<string, IOcrPendingResultFile>();
    const canonicalizePath = options.canonicalizePath ?? canonicalizePendingResultPath;

    function clearPendingResultFileCleanupTimer(entry: IOcrPendingResultFile | null | undefined) {
        if (!entry?.cleanupTimer) {
            return;
        }
        clearTimeout(entry.cleanupTimer);
        entry.cleanupTimer = null;
    }

    function removePendingResultFileEntry(scopedJobId: string) {
        const pending = pendingResultFiles.get(scopedJobId);
        if (!pending) {
            return null;
        }
        pendingResultFiles.delete(scopedJobId);
        clearPendingResultFileCleanupTimer(pending);
        return pending;
    }

    async function removeTrackedEntry(entry: IOcrPendingResultFile | null) {
        if (!entry) {
            return true;
        }
        const removed = await options.removeResultFile(entry.pdfPath);
        if (removed && pendingResultFiles.get(entry.scopedJobId) === entry) {
            removePendingResultFileEntry(entry.scopedJobId);
        }
        return removed;
    }

    const store = {
        find(webContentsId: number, requestId: string) {
            return Array.from(pendingResultFiles.values())
                .find(entry => entry.webContentsId === webContentsId && entry.requestId === requestId)
                ?? null;
        },
        findByPath(webContentsId: number, pdfPath: string) {
            const normalizedPath = typeof pdfPath === 'string'
                ? normalizePendingResultPath(pdfPath, canonicalizePath)
                : '';
            if (!normalizedPath) {
                return null;
            }

            return Array.from(pendingResultFiles.values())
                .find(entry => entry.webContentsId === webContentsId && entry.pdfPath === normalizedPath)
                ?? null;
        },
        track(scopedJobId: string, requestId: string, webContentsId: number, pdfPath: string, requiresCleanupAck: boolean) {
            if (!requiresCleanupAck) {
                void removeTrackedEntry(removePendingResultFileEntry(scopedJobId));
                return;
            }

            const normalizedPath = typeof pdfPath === 'string'
                ? normalizePendingResultPath(pdfPath, canonicalizePath)
                : '';
            if (!normalizedPath) {
                return;
            }

            const previousEntry = removePendingResultFileEntry(scopedJobId);
            if (previousEntry && previousEntry.pdfPath !== normalizedPath) {
                void options.removeResultFile(previousEntry.pdfPath);
            }

            const cleanupTimer = setTimeout(() => {
                const pending = pendingResultFiles.get(scopedJobId) ?? null;
                if (!pending) {
                    return;
                }

                void removeTrackedEntry(pending).then((removed) => {
                    if (removed) {
                        options.logger.warn(`Cleaned up stale OCR result file for job "${requestId}" after acknowledgement timeout`);
                    }
                });
            }, options.ttlMs);
            cleanupTimer.unref?.();

            pendingResultFiles.set(scopedJobId, {
                scopedJobId,
                requestId,
                webContentsId,
                pdfPath: normalizedPath,
                createdAtMs: Date.now(),
                cleanupTimer,
            });
        },
        async evictStale(nowMs = Date.now()) {
            if (pendingResultFiles.size === 0) {
                return;
            }

            const staleEntries = Array.from(pendingResultFiles.values())
                .filter(entry => nowMs - entry.createdAtMs > options.ttlMs);
            if (staleEntries.length === 0) {
                return;
            }

            let removedCount = 0;
            for (const entry of staleEntries) {
                if (await removeTrackedEntry(entry)) {
                    removedCount += 1;
                }
            }

            if (removedCount > 0) {
                options.logger.warn(`Cleaned up ${removedCount} stale OCR result file(s) without renderer acknowledgement`);
            }
        },
        async cleanupForSender(webContentsId: number) {
            const pendingEntries = Array.from(pendingResultFiles.values())
                .filter(entry => entry.webContentsId === webContentsId);
            for (const pendingEntry of pendingEntries) {
                await removeTrackedEntry(pendingEntry);
            }
        },
        async acknowledge(webContentsId: number, requestId: string, pdfPathPayload?: string) {
            const pending = this.find(webContentsId, requestId);
            if (!pending) {
                return {
                    cleaned: false,
                    error: `No pending OCR result file for requestId "${requestId}"`,
                };
            }

            if (typeof pdfPathPayload === 'string' && pdfPathPayload.trim().length > 0) {
                const normalizedPayloadPath = normalizePendingResultPath(pdfPathPayload, canonicalizePath);
                if (normalizedPayloadPath !== pending.pdfPath) {
                    return {
                        cleaned: false,
                        error: 'Acknowledged OCR result path does not match pending result path',
                    };
                }
            }

            const removed = await options.removeResultFile(pending.pdfPath);
            if (!removed) {
                return {
                    cleaned: false,
                    error: 'Failed to delete pending OCR result file',
                };
            }

            removePendingResultFileEntry(pending.scopedJobId);
            return { cleaned: true };
        },
        async shutdown() {
            const pendingEntries = Array.from(pendingResultFiles.values());
            for (const pendingEntry of pendingEntries) {
                await removeTrackedEntry(pendingEntry);
            }
            if (activeOwnershipRegistry === store) {
                activeOwnershipRegistry = null;
            }
        },
    };

    activeOwnershipRegistry = store;
    return store;
}
