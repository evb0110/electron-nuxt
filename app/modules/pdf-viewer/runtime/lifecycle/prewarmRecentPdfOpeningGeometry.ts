import type { IRecentFile } from '@contracts/shared';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import {
    prevalidateTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
    type IPdfTrustedOpenGeometry,
} from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';

const DEFAULT_RECENT_PDF_OPEN_GEOMETRY_PREWARM_LIMIT = 4;
const DEFAULT_PREWARM_CONCURRENCY = 2;

export interface IRecentPdfOpeningGeometryPrewarmPort {
    readStat?: (path: string) => Promise<{
        size: number;
        modifiedAt?: number;
    }>;
    readOpeningGeometry?: ((path: string) => Promise<IPdfOpeningGeometry>) | undefined;
}

function isPdfRecentFile(file: IRecentFile) {
    return /\.pdf$/iu.test(file.fileName || file.originalPath);
}

function selectRecentPdfOpeningGeometryCandidates(
    files: readonly IRecentFile[],
    limit = DEFAULT_RECENT_PDF_OPEN_GEOMETRY_PREWARM_LIMIT,
) {
    return files
        .filter(isPdfRecentFile)
        .slice(0, Math.max(0, Math.trunc(limit)));
}

/**
 * Starts exact first-page geometry discovery at application Recent-state warmup,
 * before any empty workspace host exposes a clickable Recent row. The trusted
 * geometry cache owns deduplication and source-revision fencing.
 */
export async function prewarmRecentPdfOpeningGeometry(
    files: readonly IRecentFile[],
    port: IRecentPdfOpeningGeometryPrewarmPort,
    options: {
        concurrency?: number;
        limit?: number;
        settleTimeoutMs?: number;
        onError?: (file: IRecentFile, error: unknown) => void;
        onSettled?: (file: IRecentFile, geometry: IPdfTrustedOpenGeometry | null) => void;
    } = {},
) {
    const candidates = selectRecentPdfOpeningGeometryCandidates(
        files,
        options.limit,
    );
    const results = new Map<string, IPdfTrustedOpenGeometry | null>();
    let nextIndex = 0;
    const workerCount = Math.min(
        candidates.length,
        Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_PREWARM_CONCURRENCY)),
    );
    const workers = Array.from({length: workerCount}, async () => {
        while (nextIndex < candidates.length) {
            const file = candidates[nextIndex++];
            if (!file) {
                return;
            }
            const alreadyValidated = readPrevalidatedTrustedPdfOpenGeometry(file.originalPath, 1);
            if (alreadyValidated && !port.readOpeningGeometry) {
                results.set(file.originalPath, alreadyValidated);
                options.onSettled?.(file, alreadyValidated);
                continue;
            }
            try {
                const geometryTask = prevalidateTrustedPdfOpenGeometry(
                    file.originalPath,
                    1,
                    port.readStat ? () => port.readStat!(file.originalPath) : undefined,
                    port.readOpeningGeometry
                        ? () => port.readOpeningGeometry!(file.originalPath)
                        : undefined,
                    {forceAuthoritativeRefresh: Boolean(port.readOpeningGeometry)},
                );
                let timedOut = false;
                let timeoutId: ReturnType<typeof setTimeout> | undefined;
                const geometry = options.settleTimeoutMs && options.settleTimeoutMs > 0
                    ? await Promise.race([
                        geometryTask,
                        new Promise<null>((resolve) => {
                            timeoutId = setTimeout(() => {
                                timedOut = true;
                                resolve(null);
                            }, options.settleTimeoutMs);
                        }),
                    ])
                    : await geometryTask;
                if (timeoutId !== undefined) {
                    clearTimeout(timeoutId);
                }
                results.set(file.originalPath, geometry);
                options.onSettled?.(file, geometry);
                if (timedOut) {
                    void geometryTask.then((lateGeometry) => {
                        if (lateGeometry) {
                            options.onSettled?.(file, lateGeometry);
                        }
                    }).catch(() => undefined);
                    // Do not launch more native probes from this slot while its
                    // timed-out operation is still running in the background.
                    return;
                }
            } catch (error) {
                results.set(file.originalPath, null);
                options.onError?.(file, error);
                options.onSettled?.(file, null);
            }
        }
    });
    await Promise.all(workers);
    return results;
}
