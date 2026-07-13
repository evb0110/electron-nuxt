import type { IRecentFile } from '@contracts/shared';
import type { IDjvuPageSourceInfo } from '@contracts/electronApiDjvu';
import type { IDocumentOpenSurfacePageGeometrySeed } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

interface ISourceStat {
    size: number;
    modifiedAt?: number;
}

const geometryByPath = new Map<string, IDocumentOpenSurfacePageGeometrySeed>();
const pendingByPath = new Map<string, Promise<IDocumentOpenSurfacePageGeometrySeed | null>>();
const DEFAULT_RECENT_DJVU_OPEN_GEOMETRY_PREWARM_LIMIT = 4;

function matchesStat(geometry: IDocumentOpenSurfacePageGeometrySeed, stat: ISourceStat) {
    return geometry.size === stat.size && geometry.modifiedAt === (stat.modifiedAt ?? 0);
}

export function readPrevalidatedTrustedDjvuOpenGeometry(path: string, pageNumber = 1) {
    const geometry = geometryByPath.get(path);
    return geometry?.pageNumber === pageNumber ? geometry : null;
}

export function cacheTrustedDjvuOpenGeometry(
    path: string,
    sourceStat: ISourceStat,
    sourceInfo: IDjvuPageSourceInfo,
) {
    const geometry: IDocumentOpenSurfacePageGeometrySeed = Object.freeze({
        documentId: path,
        pageNumber: sourceInfo.pageNumber,
        pageCount: sourceInfo.pageCount,
        width: sourceInfo.pageSize.width,
        height: sourceInfo.pageSize.height,
        rotation: 0,
        size: sourceStat.size,
        modifiedAt: sourceStat.modifiedAt ?? 0,
    });
    geometryByPath.set(path, geometry);
    return geometry;
}

async function prevalidateTrustedDjvuOpenGeometry(
    path: string,
    readStat: (() => Promise<ISourceStat>) | undefined,
    readSourceInfo: () => Promise<IDjvuPageSourceInfo>,
) {
    const existingPending = pendingByPath.get(path);
    if (existingPending) {
        return existingPending;
    }
    const pending = (async () => {
        const sourceInfo = await readSourceInfo();
        const revision = sourceInfo.sourceSize !== undefined
            && sourceInfo.sourceModifiedAt !== undefined
            ? {
                size: sourceInfo.sourceSize,
                modifiedAt: sourceInfo.sourceModifiedAt,
            }
            : await readStat?.().catch(() => null) ?? null;
        if (!revision) {
            return null;
        }
        const cached = geometryByPath.get(path);
        if (cached && matchesStat(cached, revision)) {
            return cached;
        }
        return cacheTrustedDjvuOpenGeometry(path, revision, sourceInfo);
    })().catch(() => null).finally(() => pendingByPath.delete(path));
    pendingByPath.set(path, pending);
    return pending;
}

function selectRecentDjvuOpeningGeometryCandidates(
    files: readonly IRecentFile[],
    limit = DEFAULT_RECENT_DJVU_OPEN_GEOMETRY_PREWARM_LIMIT,
) {
    return files
        .filter(file => /\.djvu?$/iu.test(file.fileName || file.originalPath))
        .slice(0, Math.max(0, Math.trunc(limit)));
}

export async function prewarmRecentDjvuOpeningGeometry(
    files: readonly IRecentFile[],
    port: {
        readStat?: (path: string) => Promise<ISourceStat>;
        readSourceInfo: (path: string) => Promise<IDjvuPageSourceInfo>;
    },
    options: {
        concurrency?: number;
        limit?: number;
        settleTimeoutMs?: number;
        onSettled?: (
            file: IRecentFile,
            geometry: IDocumentOpenSurfacePageGeometrySeed | null,
        ) => void;
    } = {},
) {
    const candidates = selectRecentDjvuOpeningGeometryCandidates(
        files,
        options.limit,
    );
    const results = new Map<string, IDocumentOpenSurfacePageGeometrySeed | null>();
    let nextIndex = 0;
    const workers = Array.from({length: Math.min(candidates.length, Math.max(1, Math.trunc(options.concurrency ?? 2)))}, async () => {
        while (nextIndex < candidates.length) {
            const file = candidates[nextIndex++];
            if (!file) {
                return;
            }
            const geometryTask = prevalidateTrustedDjvuOpenGeometry(
                file.originalPath,
                port.readStat ? () => port.readStat!(file.originalPath) : undefined,
                () => port.readSourceInfo(file.originalPath),
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
                });
            }
        }
    });
    await Promise.all(workers);
    return results;
}
