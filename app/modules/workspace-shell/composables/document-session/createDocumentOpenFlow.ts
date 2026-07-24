import { clamp } from 'es-toolkit/math';
import type {
    IAnalyticsDocumentScope,
    useAnalytics,
} from '@app/composables/useAnalytics';
import type { TTranslateFn } from '@i18n-app';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IDocumentMutationRevisionOptions,
    TOpenFileResult,
} from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IPdfRasterDisplayProfileOpenOptions } from '@app/types/pdfRasterDisplayProfile';
import {consumeRegisteredPdfRasterDisplayProfile} from '@app/types/pdfRasterDisplayProfile';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    createEpochGuard,
    IDocumentSessionState,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import type { IPdfLoadedState } from '@app/modules/workspace-shell/composables/document-session/createDocumentHistory';
import type { IPdfConformanceDeferralOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import {
    bucketFileSize,
    getLowercaseExtension,
} from '@app/utils/analytics';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';
import {
    getDocumentFilesCapability,
    getDocumentOpenCapability,
    getDocumentPickerCapability,
    getDocumentRecentFilesCapability,
} from '@app/utils/platformDocuments';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    cacheTrustedPdfOpenGeometry,
    readPrevalidatedTrustedPdfOpenGeometry,
} from '@app/modules/pdf-viewer/public/openGeometry';

type TAnalytics = ReturnType<typeof useAnalytics>;
type TEpochGuard = ReturnType<typeof createEpochGuard>;
export type TDocumentDirectOpenOptions = IPdfRasterDisplayProfileOpenOptions;

interface ICreateDocumentOpenFlowDeps {
    analytics: TAnalytics;
    analyticsDocumentScope: IAnalyticsDocumentScope;
    cleanupAbandonedWorkingCopy: (path: TDocumentRef) => Promise<void>;
    clearPdfConformanceProfile: () => void;
    cleanupPreviousWorkingCopy: (path: TDocumentRef, nextPath: TDocumentRef) => Promise<void>;
    deferPdfConformanceProfile: (
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) => void;
    incrementSessionVersion: () => void;
    ensureHistoryBaselineForMutation: () => Promise<boolean>;
    loadEpoch: TEpochGuard;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
    openEpoch: TEpochGuard;
    pushHistorySnapshot: (
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) => Promise<boolean>;
    resetHistory: (
        snapshot: Uint8Array | null,
        options?: {
            reuseSnapshot?: boolean;
            isCurrent?: (() => boolean) | undefined;
        },
    ) => Promise<boolean>;
    syncDirtyFromHistory: () => void;
    t: TTranslateFn;
}

const RECENT_OPEN_LOG_SECTION = 'recent-open';
const MAX_EAGER_HISTORY_BASELINE_BYTES = 8 * 1024 * 1024;

function createDocumentMutationRevisionOptions(
    expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined,
): IDocumentMutationRevisionOptions | undefined {
    if (expectedDocumentRevisionToken === null || expectedDocumentRevisionToken === undefined) {
        return undefined;
    }
    return { expectedDocumentRevisionToken };
}

export function createDocumentOpenFlow(
    state: IDocumentSessionState,
    deps: ICreateDocumentOpenFlowDeps,
) {
    const performancePolicy = resolveOpenPathSecondaryPerformancePolicy(getPerformanceProfile());
    const {
        deferMediumHistoryBaseline,
        geometryPreflightMode,
        maxInMemoryPdfBytes,
    } = performancePolicy;

    function assertPdfHasBytes(size: number) {
        if (size > 0) {
            return;
        }

        throw new Error(deps.t('errors.file.emptyPdf'));
    }

    function toPdfBlob(snapshot: Uint8Array) {
        const ownedSnapshot = (
            snapshot.buffer instanceof ArrayBuffer
            && snapshot.byteOffset === 0
            && snapshot.byteLength === snapshot.buffer.byteLength
        )
            ? snapshot as Uint8Array<ArrayBuffer>
            : (
                snapshot.byteOffset === 0
                && snapshot.byteLength === snapshot.buffer.byteLength
            )
                ? new Uint8Array(snapshot)
                : snapshot.slice();
        return new Blob([ownedSnapshot], { type: 'application/pdf' });
    }

    function getLoadedPdfFileSize(nextState: IPdfLoadedState) {
        if (nextState.pdfData) {
            return nextState.pdfData.byteLength;
        }
        const source = nextState.pdfSrc;
        if (
            source
            && typeof source === 'object'
            && 'kind' in source
            && source.kind === 'path'
        ) {
            return source.size;
        }
        return null;
    }

    async function pickFileToOpen() {
        return getDocumentPickerCapability().openDocumentDialog();
    }

    async function trackOpenedDocument(
        result: TOpenFileResult,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
    ) {
        const fileName = getDocumentRefBaseName(result.originalPath);
        let fileSizeBucket: string | null = null;

        if (result.kind === 'pdf') {
            try {
                // The open result has already adopted a managed working copy.
                // Renderer file capabilities deliberately cannot stat an
                // arbitrary original path; the byte-identical working copy is
                // the authoritative readable source for analytics size.
                const { size } = await getDocumentFilesCapability().statFile(result.workingPath);
                fileSizeBucket = bucketFileSize(size);
            } catch {
                fileSizeBucket = null;
            }
        }

        deps.analyticsDocumentScope.set({
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            pageCountBucket: null,
            totalPages: null,
        });
        deps.analytics.track('document_opened', {
            documentKind: result.kind,
            fileExtension: getLowercaseExtension(fileName),
            fileSizeBucket,
            isGenerated: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
            openMethod,
            requiresSaveAsOnFirstSave: result.kind === 'pdf' ? Boolean(result.isGenerated) : false,
        });
    }

    function beginOpenRequest() {
        deps.loadEpoch.invalidate();
        return deps.openEpoch.begin();
    }

    function isCurrentOpenRequest(requestId: number) {
        return deps.openEpoch.isCurrent(requestId);
    }

    function isCurrentLoadRequest(requestId: number) {
        return deps.loadEpoch.isCurrent(requestId);
    }

    function isCurrentOpenLoadRequest(openRequestId: number, loadRequestId: number) {
        return isCurrentOpenRequest(openRequestId) && isCurrentLoadRequest(loadRequestId);
    }

    function startPdfOpeningGeometryResolution(
        openRequestId: number,
        result: Extract<TOpenFileResult, { kind: 'pdf' }>,
    ) {
        const openSurface = deps.openSurface;
        const surfaceSnapshot = openSurface?.snapshot.value;
        const cachedGeometry = readPrevalidatedTrustedPdfOpenGeometry(result.originalPath, 1);

        if (
            cachedGeometry
            && openSurface
            && surfaceSnapshot?.phase === 'pending'
            && surfaceSnapshot.identity?.documentId === result.originalPath
            && openSurface.viewportSession.value.requestedPage === cachedGeometry.pageNumber
            && isCurrentOpenRequest(openRequestId)
        ) {
            openSurface.commitOpeningPageGeometry(surfaceSnapshot.generation, cachedGeometry);
        }

        const readOpeningGeometry = getDocumentFilesCapability().getPdfOpeningGeometry;
        if (geometryPreflightMode !== 'concurrent' || !readOpeningGeometry) {
            return;
        }

        const geometryTask = readOpeningGeometry(result.workingPath);
        const recentSourceTask = getDocumentRecentFilesCapability().recentFiles.get()
            .then(files => files.find(file => file.originalPath === result.originalPath) ?? null)
            .catch(() => null);
        void Promise.all([
            geometryTask,
            recentSourceTask,
        ])
            .then(([
                openingGeometry,
                recentSource,
            ]) => {
                if (openingGeometry === null) {
                    return null;
                }
                const recentSourceRevision = recentSource?.fileSize !== undefined
                    && recentSource.modifiedAt !== undefined
                    ? {
                        size: recentSource.fileSize,
                        modifiedAt: recentSource.modifiedAt,
                    }
                    : undefined;
                const sourceRevision = result.openingGeometry
                    ?? cachedGeometry
                    ?? recentSourceRevision;
                return cacheTrustedPdfOpenGeometry(
                    result.originalPath,
                    openingGeometry,
                    {
                        makeSynchronouslyAvailable: sourceRevision !== undefined,
                        ...(sourceRevision ? {sourceRevision} : {}),
                    },
                );
            })
            .catch((error: unknown) => {
                BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'PDF opening geometry unavailable', {
                    workingPath: result.workingPath,
                    error: getErrorMessage(error),
                });
            });
    }

    async function cleanupAbandonedPdfWorkingCopy(
        result: TOpenFileResult,
        reason: string,
    ) {
        if (result.kind !== 'pdf' || state.isActiveWorkingCopy(result.workingPath)) {
            return;
        }

        try {
            await deps.cleanupAbandonedWorkingCopy(result.workingPath);
        } catch (cleanupError) {
            BrowserLogger.warn(
                RECENT_OPEN_LOG_SECTION,
                'Failed to cleanup abandoned PDF working copy',
                {
                    path: result.workingPath,
                    reason,
                    error: cleanupError,
                },
            );
        }
    }

    async function openFile(preSelected?: TOpenFileResult) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        try {
            const result = preSelected ?? (await pickFileToOpen());
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-picker-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return { status: 'cancelled' } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                return { status: 'cancelled' } satisfies TDocumentOpenOutcome;
            }
            if (result.kind === 'djvu') {
                state.pendingDjvu.value = result.originalPath;
                BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {
                    reason: 'picker-result-ready',
                    openRequestId,
                    path: result.originalPath,
                });
                await trackOpenedDocument(result, preSelected ? 'preselected' : 'picker');
                return {
                    status: 'prepared',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            return await finishPdfOpenResult(
                openRequestId,
                result,
                preSelected ? 'preselected' : 'picker',
            );
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: classifyOpenError(e, preSelected?.originalPath ?? null),
                } satisfies TDocumentOpenOutcome;
            }
            const message = classifyOpenError(e, preSelected?.originalPath ?? null);
            state.error.value = message;
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function finishPdfOpenResult(
        openRequestId: number,
        result: Extract<TOpenFileResult, { kind: 'pdf' }>,
        openMethod: 'picker' | 'preselected' | 'direct' | 'batch',
        options: IPdfRasterDisplayProfileOpenOptions = {},
    ) {
        const registeredRasterDisplayProfile = consumeRegisteredPdfRasterDisplayProfile(
            result.originalPath,
            result.workingPath,
        );
        const rasterDisplayProfile = options.rasterDisplayProfile
            ?? registeredRasterDisplayProfile;
        startPdfOpeningGeometryResolution(
            openRequestId,
            result,
        );
        try {
            await loadPdfFromPath(result.workingPath, {
                markDirty: !!result.isGenerated,
                openRequestId,
                resetSourceBeforeCommit: true,
            });
        } catch (error) {
            await cleanupAbandonedPdfWorkingCopy(result, 'failed-pdf-load');
            throw error;
        }
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-load');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        await trackOpenedDocument(result, openMethod);
        if (!isCurrentOpenRequest(openRequestId) || state.workingCopyPath.value !== result.workingPath) {
            await cleanupAbandonedPdfWorkingCopy(result, 'stale-pdf-track');
            return {
                status: 'stale',
                result,
            } satisfies TDocumentOpenOutcome;
        }
        state.originalPath.value = result.originalPath;
        state.requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        state.pdfRasterDisplayProfile.value = rasterDisplayProfile;
        return {
            status: 'opened',
            result,
        } satisfies TDocumentOpenOutcome;
    }

    async function openFileDirect(path: TDocumentRef, options: TDocumentDirectOpenOptions = {}) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        logPdfRenderTrace('pdf-open-direct-start', {
            openRequestId,
            path,
            wallTimeMs: Date.now(),
            performanceTimeOrigin: typeof performance === 'undefined' ? null : performance.timeOrigin,
        });
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect started', {path});
        try {
            const openCapabilityStartedAt = performance.now();
            logPdfRenderTrace('pdf-open-capability-start', {
                openRequestId,
                path,
            });
            const result = await getDocumentOpenCapability().openDocumentDirect(path);
            logPdfRenderTrace('pdf-open-capability-end', {
                openRequestId,
                path,
                elapsedMs: performance.now() - openCapabilityStartedAt,
                resultKind: result?.kind ?? null,
                workingPath: result?.kind === 'pdf' ? result.workingPath : null,
            });
            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-direct-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: deps.t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                const message = deps.t('errors.file.invalid');
                state.error.value = message;
                BrowserLogger.warn(
                    RECENT_OPEN_LOG_SECTION,
                    'openDocumentDirect returned null',
                    { path },
                );
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }

            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'openDocumentDirect returned result',
                {
                    path,
                    kind: result.kind,
                    isGenerated:
                        result.kind === 'pdf' ? Boolean(result.isGenerated) : undefined,
                    workingPath: result.kind === 'pdf' ? result.workingPath : undefined,
                },
            );

            if (result.kind === 'djvu') {
                state.pendingDjvu.value = result.originalPath;
                BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {
                    reason: 'direct-result-ready',
                    openRequestId,
                    path: result.originalPath,
                });
                await trackOpenedDocument(result, 'direct');
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect entered DjVu mode',
                    {
                        path,
                        djvuPath: result.originalPath,
                    },
                );
                return {
                    status: 'prepared',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            BrowserLogger.debug(
                RECENT_OPEN_LOG_SECTION,
                'Loading PDF from working path',
                {
                    path,
                    workingPath: result.workingPath,
                },
            );
            const outcome = await finishPdfOpenResult(openRequestId, result, 'direct', options);
            if (outcome.status === 'stale') {
                BrowserLogger.debug(
                    RECENT_OPEN_LOG_SECTION,
                    'openFileDirect skipped stale load result',
                    {
                        path,
                        workingPath: result.workingPath,
                    },
                );
                return outcome;
            }
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect completed', {
                path,
                workingPath: result.workingPath,
                originalPath: result.originalPath,
                requiresSaveAsOnFirstSave: state.requiresSaveAsOnFirstSave.value,
            });
            logPdfRenderTrace('pdf-open-direct-end', {
                openRequestId,
                path,
                status: outcome.status,
                workingPath: result.workingPath,
            });
            return outcome;
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: classifyOpenError(e, path),
                } satisfies TDocumentOpenOutcome;
            }
            const message = classifyOpenError(e, path);
            state.error.value = message;
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'openFileDirect failed', {
                path,
                error: getErrorMessage(e),
            });
            logPdfRenderTrace('pdf-open-direct-end', {
                openRequestId,
                path,
                status: 'failed',
                error: getErrorMessage(e),
            });
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    function classifyOpenError(e: unknown, path: TDocumentRef | null) {
        const rawMessage = e instanceof Error ? e.message : '';
        if (rawMessage && /ENOENT|could not be found|no such file|chunk missing|does not exist/i.test(rawMessage)) {
            const baseName = path ? getDocumentRefBaseName(path) : '';
            const name = baseName && baseName.length > 0 ? baseName : path ? String(path) : '';
            return deps.t('errors.file.openNotFound', { name });
        }
        return rawMessage || deps.t('errors.file.open');
    }

    async function openFileDirectBatch(paths: TDocumentRef[]) {
        const openRequestId = beginOpenRequest();
        state.error.value = null;
        state.pendingDjvu.value = null;
        state.openBatchProgress.value = null;
        try {
            const documentOpen = getDocumentOpenCapability();
            const normalizedPaths = paths
                .map((path) => path.trim())
                .filter((path) => path.length > 0);

            if (normalizedPaths.length === 0) {
                const message = deps.t('errors.file.invalid');
                if (isCurrentOpenRequest(openRequestId)) {
                    state.error.value = message;
                }
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }

            const requestId = crypto.randomUUID();
            state.openBatchProgress.value = {
                processed: 0,
                total: normalizedPaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };

            const stopProgress = documentOpen.onOpenDocumentDirectBatchProgress(
                (progress) => {
                    if (
                        progress.operation !== 'document-open'
                        || progress.requestId !== requestId
                        || !isCurrentOpenRequest(openRequestId)
                    ) {
                        return;
                    }

                    state.openBatchProgress.value = {
                        processed: Math.max(0, progress.processed),
                        total: Math.max(0, progress.total),
                        percent: clamp(progress.percent, 0, 100),
                        elapsedMs: Math.max(0, progress.elapsedMs),
                        estimatedRemainingMs:
                            typeof progress.estimatedRemainingMs === 'number'
                                ? Math.max(0, progress.estimatedRemainingMs)
                                : null,
                    };
                },
            );

            let result: TOpenFileResult | null = null;
            try {
                result = await documentOpen.openDocumentDirectBatch(
                    normalizedPaths,
                    requestId,
                );
            } finally {
                stopProgress();
            }

            if (!isCurrentOpenRequest(openRequestId)) {
                if (result) {
                    await cleanupAbandonedPdfWorkingCopy(result, 'stale-batch-result');
                    return {
                        status: 'stale',
                        result,
                    } satisfies TDocumentOpenOutcome;
                }
                return {
                    status: 'failed',
                    error: deps.t('errors.file.invalid'),
                } satisfies TDocumentOpenOutcome;
            }
            if (!result) {
                state.openBatchProgress.value = null;
                const message = deps.t('errors.file.invalid');
                state.error.value = message;
                return {
                    status: 'failed',
                    error: message,
                } satisfies TDocumentOpenOutcome;
            }
            if (result.kind === 'djvu') {
                state.openBatchProgress.value = null;
                state.pendingDjvu.value = result.originalPath;
                BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'DjVu open prepared', {
                    reason: 'batch-result-ready',
                    openRequestId,
                    path: result.originalPath,
                });
                await trackOpenedDocument(result, 'batch');
                return {
                    status: 'prepared',
                    result,
                } satisfies TDocumentOpenOutcome;
            }
            state.openBatchProgress.value = null;
            return await finishPdfOpenResult(openRequestId, result, 'batch');
        } catch (e) {
            if (!isCurrentOpenRequest(openRequestId)) {
                return {
                    status: 'failed',
                    error: e instanceof Error ? e.message : deps.t('errors.file.open'),
                } satisfies TDocumentOpenOutcome;
            }
            state.openBatchProgress.value = null;
            const message = e instanceof Error ? e.message : deps.t('errors.file.open');
            state.error.value = message;
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
    }

    async function applyLoadedPdfState(
        path: TDocumentRef,
        nextState: IPdfLoadedState,
        options?: {
            markDirty?: boolean;
            preserveHistory?: boolean;
            previousPath?: TDocumentRef | null;
            isCurrent?: (() => boolean) | undefined;
        },
    ) {
        if (options?.isCurrent?.() === false) {
            return false;
        }

        const didRefreshRevision = await refreshDocumentRevisionToken(path, options?.isCurrent);
        if (!didRefreshRevision) {
            return false;
        }

        state.workingCopyPath.value = path;
        state.pdfData.value = nextState.pdfData;
        state.pdfSrc.value = nextState.pdfSrc;
        state.pdfReloadSrc.value = nextState.pdfSrc;
        deps.clearPdfConformanceProfile();

        if (!options?.preserveHistory) {
            deps.incrementSessionVersion();
            if (
                nextState.pdfData
                && (
                    !deferMediumHistoryBaseline
                    || nextState.pdfData.byteLength <= MAX_EAGER_HISTORY_BASELINE_BYTES
                )
            ) {
                const didResetHistory = await deps.resetHistory(nextState.pdfData, {
                    reuseSnapshot: true,
                    isCurrent: options?.isCurrent,
                });
                if (!didResetHistory || options?.isCurrent?.() === false) {
                    return false;
                }
                deps.syncDirtyFromHistory();
            } else {
                const didResetHistory = await deps.resetHistory(null, { isCurrent: options?.isCurrent });
                if (!didResetHistory || options?.isCurrent?.() === false) {
                    return false;
                }
            }
        }

        if (options?.isCurrent?.() === false) {
            return false;
        }

        if (typeof options?.markDirty === 'boolean') {
            state.isDirty.value = options.markDirty;
        }

        if (
            options?.previousPath
            && options.previousPath !== path
            && options.isCurrent?.() !== false
        ) {
            await deps.cleanupPreviousWorkingCopy(options.previousPath, path);
            if (options.isCurrent?.() === false) {
                return false;
            }
        }

        deps.deferPdfConformanceProfile(path, { fileSize: getLoadedPdfFileSize(nextState) });
        return true;
    }

    async function refreshDocumentRevisionToken(
        path: TDocumentRef,
        isCurrent?: (() => boolean) | undefined,
    ) {
        if (isCurrent?.() === false) {
            return false;
        }

        try {
            const revision = await getDocumentFilesCapability().getDocumentRevision(path);
            if (isCurrent?.() === false) {
                return false;
            }
            state.documentRevisionInfo.value = revision;
            state.documentRevisionToken.value = revision.token;
        } catch (error) {
            if (isCurrent?.() === false) {
                return false;
            }
            state.documentRevisionInfo.value = null;
            state.documentRevisionToken.value = null;
            BrowserLogger.warn('pdf-file', 'Failed to resolve document revision', {
                path,
                error,
            });
        }
        return true;
    }

    async function readPdfStateFromPath(
        path: TDocumentRef,
        traceContext?: {
            openRequestId?: number;
            loadRequestId: number
        },
    ): Promise<IPdfLoadedState> {
        const statStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-source-stat-start', {
            path,
            ...traceContext,
        });
        const { size } = await getDocumentFilesCapability().statFile(path);
        logPdfRenderTrace('pdf-open-source-stat-end', {
            path,
            ...traceContext,
            size,
            elapsedMs: performance.now() - statStartedAt,
        });
        assertPdfHasBytes(size);

        if (size > maxInMemoryPdfBytes) {
            logPdfRenderTrace('pdf-open-source-ready', {
                path,
                ...traceContext,
                sourceKind: 'path',
                declaredSize: size,
                directBinaryPayloadLimit: maxInMemoryPdfBytes,
            });
            return {
                pdfData: null,
                pdfSrc: {
                    kind: 'path' as const,
                    path,
                    size,
                },
            };
        }

        const readStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-source-read-start', {
            path,
            ...traceContext,
            declaredSize: size,
        });
        const data = await readDocumentBytes(path, {
            knownSize: size,
            maxBytes: maxInMemoryPdfBytes,
        });
        logPdfRenderTrace('pdf-open-source-read-end', {
            path,
            ...traceContext,
            sourceKind: 'data',
            declaredSize: size,
            bytesRead: data.byteLength,
            elapsedMs: performance.now() - readStartedAt,
        });
        return {
            pdfData: data,
            pdfSrc: toPdfBlob(data) as TPdfSource,
        };
    }

    async function loadPdfFromPath(path: TDocumentRef, opts?: {
        markDirty?: boolean;
        openRequestId?: number;
        resetSourceBeforeCommit?: boolean;
    }) {
        const requestId = deps.loadEpoch.begin();
        const traceContext = {
            ...(opts?.openRequestId === undefined ? {} : { openRequestId: opts.openRequestId }),
            loadRequestId: requestId,
        };
        const isCurrent = () => (
            isCurrentLoadRequest(requestId)
            && (
                opts?.openRequestId === undefined
                || isCurrentOpenLoadRequest(opts.openRequestId, requestId)
            )
        );
        // Yield one visual frame so upstream loading indicators (e.g. the
        // workspace host spinner) can paint before the potentially heavy file
        // read blocks the renderer thread during IPC deserialization.
        const visualYieldStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-visual-yield-start', {
            path,
            ...traceContext,
        });
        await waitForVisualFrames();
        logPdfRenderTrace('pdf-open-visual-yield-end', {
            path,
            ...traceContext,
            elapsedMs: performance.now() - visualYieldStartedAt,
        });
        if (!isCurrent()) {
            return;
        }

        // Verify and read file BEFORE committing any reactive state.
        // This prevents an inconsistent UI where the tab shows metadata
        // (filename, dirty dot) but the content area shows the empty state
        // because pdfSrc remained unset after a failed read.
        // Only the file state is needed for rendering; conformance analysis
        // (used only for save restrictions) is deferred so it does not block
        // the initial display of the document.
        const nextState = await readPdfStateFromPath(path, traceContext);

        if (!isCurrent()) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF load result', {
                path,
                requestId,
                currentLoadRequestId: deps.loadEpoch.current(),
            });
            return;
        }

        if (opts?.resetSourceBeforeCommit && state.pdfSrc.value) {
            state.pdfSrc.value = null;
            state.pdfReloadSrc.value = null;
            await nextTick();
            if (!isCurrent()) {
                return;
            }
        }

        // Keep the previous working copy until the new file is fully validated and loaded.
        // This avoids dropping recoverable state when opening the next file fails midway.
        const commitStartedAt = performance.now();
        logPdfRenderTrace('pdf-open-state-commit-start', {
            path,
            ...traceContext,
            sourceKind: nextState.pdfData ? 'data' : 'path',
        });
        const didCommit = await applyLoadedPdfState(path, nextState, {
            isCurrent,
            markDirty: !!opts?.markDirty,
            previousPath: state.workingCopyPath.value,
        });
        logPdfRenderTrace('pdf-open-state-commit-end', {
            path,
            ...traceContext,
            didCommit,
            elapsedMs: performance.now() - commitStartedAt,
        });
    }

    async function applySnapshot(
        snapshot: Uint8Array,
        persist = false,
        expectedWorkingPath: TDocumentRef | null = state.workingCopyPath.value,
    ) {
        if (expectedWorkingPath !== state.workingCopyPath.value) {
            return false;
        }
        if (persist && expectedWorkingPath) {
            await getDocumentFilesCapability().writeFile(
                expectedWorkingPath,
                snapshot,
                createDocumentMutationRevisionOptions(state.documentRevisionToken.value),
            );
            if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
                return false;
            }
        }

        state.pdfData.value = snapshot;
        state.pdfSrc.value = toPdfBlob(snapshot);
        state.pdfReloadSrc.value = state.pdfSrc.value;
        return true;
    }

    async function loadPdfFromData(
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) {
        const requestId = deps.loadEpoch.begin();
        const expectedWorkingPath = state.workingCopyPath.value;
        const snapshot = data.slice();
        assertPdfHasBytes(snapshot.byteLength);
        if (!deps.loadEpoch.isCurrent(requestId)) {
            return;
        }
        if (!await deps.ensureHistoryBaselineForMutation()) {
            return;
        }
        if (
            !deps.loadEpoch.isCurrent(requestId)
            || expectedWorkingPath !== state.workingCopyPath.value
        ) {
            return;
        }
        const didApplySnapshot = await applySnapshot(
            snapshot,
            opts?.persistWorkingCopy ?? false,
            expectedWorkingPath,
        );
        if (!didApplySnapshot || !deps.loadEpoch.isCurrent(requestId)) {
            BrowserLogger.debug('pdf-file', 'Skipped stale PDF data load result', {
                requestId,
                currentLoadRequestId: deps.loadEpoch.current(),
                bytes: snapshot.byteLength,
                expectedWorkingPath,
                currentWorkingPath: state.workingCopyPath.value,
            });
            return;
        }

        if (opts?.pushHistory !== false) {
            await deps.pushHistorySnapshot(snapshot, { reuseSnapshot: true });
        } else {
            state.isDirty.value = true;
        }

        if (opts?.persistWorkingCopy && expectedWorkingPath && state.isActiveWorkingCopy(expectedWorkingPath)) {
            deps.deferPdfConformanceProfile(expectedWorkingPath);
        }
    }

    return {
        applyLoadedPdfState,
        loadPdfFromData,
        loadPdfFromPath,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        pickFileToOpen,
        readPdfStateFromPath,
        toPdfBlob,
    };
}
