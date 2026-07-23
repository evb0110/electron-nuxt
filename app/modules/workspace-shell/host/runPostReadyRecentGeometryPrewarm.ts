import type { IDjvuPageSourceInfo } from '@contracts/electronApiDjvu';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { IStartupWorkProfile } from '@app/utils/startupWorkProfile';
import {
    beginRecentOpenGeometryPrewarm,
    settleRecentOpenGeometryPrewarm,
} from '@app/modules/workspace-shell/host/recentOpenGeometryReadiness';

export interface IPostReadyRecentGeometryPorts {
    readPdfOpeningGeometry?: (path: string) => Promise<IPdfOpeningGeometry>;
    readDjvuSourceInfo: (path: string) => Promise<IDjvuPageSourceInfo>;
}

export interface IRunPostReadyRecentGeometryPrewarmOptions {
    files: readonly IRecentFile[];
    ports: IPostReadyRecentGeometryPorts;
    profile: IStartupWorkProfile;
    settleTimeoutMs?: number;
    onError?: (kind: 'pdf' | 'djvu', path: string, error: unknown) => void;
}

export interface IPostReadyRecentGeometryPrewarmResult {
    pdfCandidateCount: number;
    djvuCandidateCount: number;
    pdfSettledCount: number;
    djvuSettledCount: number;
}

function selectCandidates(
    files: readonly IRecentFile[],
    extensionPattern: RegExp,
    limit: number,
) {
    return files
        .filter((file) => {
            const fileName = file.fileName.length > 0 ? file.fileName : file.originalPath;
            return extensionPattern.test(fileName);
        })
        .slice(0, limit);
}

export async function runPostReadyRecentGeometryPrewarm(
    options: IRunPostReadyRecentGeometryPrewarmOptions,
): Promise<IPostReadyRecentGeometryPrewarmResult> {
    const {
        recentGeometryCandidateLimit: limit,
        recentGeometryConcurrency: concurrency,
    } = options.profile;
    const settleTimeoutMs = options.settleTimeoutMs ?? 1_500;
    const pdfCandidates = selectCandidates(options.files, /\.pdf$/iu, limit);
    const djvuCandidates = selectCandidates(options.files, /\.djvu?$/iu, limit);

    beginRecentOpenGeometryPrewarm(pdfCandidates.map(file => file.originalPath));
    beginRecentOpenGeometryPrewarm(djvuCandidates.map(file => file.originalPath));

    const pdfPipeline = (async () => {
        try {
            const { prewarmRecentPdfOpeningGeometry } = await import(
                '@app/modules/pdf-viewer/public/prewarmRecentPdfOpeningGeometry'
            );
            const results = await prewarmRecentPdfOpeningGeometry(
                options.files,
                {readOpeningGeometry: options.ports.readPdfOpeningGeometry},
                {
                    concurrency,
                    limit,
                    settleTimeoutMs,
                    onError: (file, error) => {
                        options.onError?.('pdf', file.originalPath, error);
                    },
                    onSettled: (file, geometry) => {
                        settleRecentOpenGeometryPrewarm(
                            file.originalPath,
                            geometry ? 'ready' : 'cold-fallback',
                        );
                    },
                },
            );
            for (const file of pdfCandidates) {
                if (!results.has(file.originalPath)) {
                    settleRecentOpenGeometryPrewarm(file.originalPath, 'cold-fallback');
                }
            }
            return results.size;
        } catch (error) {
            for (const file of pdfCandidates) {
                settleRecentOpenGeometryPrewarm(file.originalPath, 'cold-fallback');
                options.onError?.('pdf', file.originalPath, error);
            }
            return 0;
        }
    })();

    const djvuPipeline = (async () => {
        try {
            const { prewarmRecentDjvuOpeningGeometry } = await import(
                '@app/modules/djvu-viewer/public/prewarmRecentDjvuOpeningGeometry'
            );
            const results = await prewarmRecentDjvuOpeningGeometry(
                options.files,
                {readSourceInfo: async (path) => {
                    try {
                        return await options.ports.readDjvuSourceInfo(path);
                    } catch (error) {
                        options.onError?.('djvu', path, error);
                        throw error;
                    }
                }},
                {
                    concurrency,
                    limit,
                    settleTimeoutMs,
                    onSettled: (file, geometry) => {
                        settleRecentOpenGeometryPrewarm(
                            file.originalPath,
                            geometry ? 'ready' : 'cold-fallback',
                        );
                    },
                },
            );
            for (const file of djvuCandidates) {
                if (!results.has(file.originalPath)) {
                    settleRecentOpenGeometryPrewarm(file.originalPath, 'cold-fallback');
                }
            }
            return results.size;
        } catch (error) {
            for (const file of djvuCandidates) {
                settleRecentOpenGeometryPrewarm(file.originalPath, 'cold-fallback');
                options.onError?.('djvu', file.originalPath, error);
            }
            return 0;
        }
    })();

    const [
        pdfSettledCount,
        djvuSettledCount,
    ] = await Promise.all([
        pdfPipeline,
        djvuPipeline,
    ]);

    return {
        pdfCandidateCount: pdfCandidates.length,
        djvuCandidateCount: djvuCandidates.length,
        pdfSettledCount,
        djvuSettledCount,
    };
}
