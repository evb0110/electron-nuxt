import type { IOcrPendingResultFile } from '@electron/ocr/jobManager.types';

interface ILogger {warn(message: string): void;}

interface ICreatePendingResultFileStoreOptions {
    logger: ILogger;
    ttlMs: number;
    removeResultFile: (path: string) => Promise<void>;
}

export function createPendingResultFileStore(options: ICreatePendingResultFileStoreOptions) {
    const pendingResultFiles = new Map<string, IOcrPendingResultFile>();

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
            return;
        }
        await options.removeResultFile(entry.pdfPath);
    }

    return {
        find(webContentsId: number, requestId: string) {
            return Array.from(pendingResultFiles.values())
                .find(entry => entry.webContentsId === webContentsId && entry.requestId === requestId)
                ?? null;
        },
        track(scopedJobId: string, requestId: string, webContentsId: number, pdfPath: string) {
            const normalizedPath = typeof pdfPath === 'string' ? pdfPath.trim() : '';
            if (!normalizedPath) {
                return;
            }

            const previousEntry = removePendingResultFileEntry(scopedJobId);
            if (previousEntry && previousEntry.pdfPath !== normalizedPath) {
                void options.removeResultFile(previousEntry.pdfPath);
            }

            const cleanupTimer = setTimeout(() => {
                const pending = removePendingResultFileEntry(scopedJobId);
                if (!pending) {
                    return;
                }

                void options.removeResultFile(pending.pdfPath);
                options.logger.warn(`Cleaned up stale OCR result file for job "${requestId}" after acknowledgement timeout`);
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

            for (const entry of staleEntries) {
                await removeTrackedEntry(removePendingResultFileEntry(entry.scopedJobId));
            }

            options.logger.warn(`Cleaned up ${staleEntries.length} stale OCR result file(s) without renderer acknowledgement`);
        },
        async cleanupForSender(webContentsId: number) {
            const pendingEntries = Array.from(pendingResultFiles.values())
                .filter(entry => entry.webContentsId === webContentsId);
            for (const pendingEntry of pendingEntries) {
                await removeTrackedEntry(removePendingResultFileEntry(pendingEntry.scopedJobId));
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
                const normalizedPayloadPath = pdfPathPayload.trim();
                if (normalizedPayloadPath !== pending.pdfPath) {
                    return {
                        cleaned: false,
                        error: 'Acknowledged OCR result path does not match pending result path',
                    };
                }
            }

            const removedEntry = removePendingResultFileEntry(pending.scopedJobId);
            if (!removedEntry) {
                return {
                    cleaned: false,
                    error: `No pending OCR result file for requestId "${requestId}"`,
                };
            }

            await options.removeResultFile(removedEntry.pdfPath);
            return { cleaned: true };
        },
        async shutdown() {
            const pendingEntries = Array.from(pendingResultFiles.values());
            pendingResultFiles.clear();
            for (const pendingEntry of pendingEntries) {
                clearPendingResultFileCleanupTimer(pendingEntry);
                await options.removeResultFile(pendingEntry.pdfPath);
            }
        },
    };
}
