import type {
    IPdfNativePageSize,
    IPdfNativePageSizes,
    IPdfOpeningGeometry,
} from '@contracts/electronApiDocuments';
import {PDF_NATIVE_PAGE_SIZE_OVERRIDE_LIMIT} from '@contracts/electronApiDocuments';
import type { IPdfPathSource } from '@app/types/pdfUi';
import type {
    IDocumentOpenSurfaceSession,
    IDocumentOpenSurfaceSnapshot,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { getErrorMessage } from '@app/utils/error';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/public';
import { createPagePreviewDocumentSource } from '@app/utils/document-viewer/source/createPagePreviewDocumentSource';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import { shouldStageNativePdfOpeningPreview } from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import type { IPdfValidationSourceRevision } from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';

type TNativePreviewFiles = Parameters<typeof createNativePdfPreviewSourceFromPath>[1];

export interface IPdfOpeningGeometryResolution {
    readonly openingGeometry: IPdfOpeningGeometry | null;
    readonly sourceRevision: IPdfValidationSourceRevision | null;
}

export interface IStagedPdfOpeningPreview {cancel(reason: string): void;}

function isOpeningTransitionPhase(phase: IDocumentOpenSurfaceSnapshot['phase']) {
    return phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
}

function resolveTargetWidth(
    surface: IDocumentOpenSurfaceSession,
    geometry: Pick<IPdfOpeningGeometry, 'width'>,
) {
    const frameWidth = Number.parseFloat(
        surface.snapshot.value.openingPageFrame?.style.width ?? '',
    );
    const cssWidth = Number.isFinite(frameWidth) && frameWidth > 0
        ? frameWidth
        : geometry.width;
    const pixelRatio = typeof window === 'undefined'
        ? 1
        : Math.max(1, window.devicePixelRatio || 1);
    return Math.min(4_096, Math.max(64, Math.ceil(cssWidth * pixelRatio)));
}

function isValidPageSize(value: unknown): value is IPdfNativePageSize {
    return typeof value === 'object'
        && value !== null
        && Number.isFinite((value as IPdfNativePageSize).width)
        && (value as IPdfNativePageSize).width > 0
        && Number.isFinite((value as IPdfNativePageSize).height)
        && (value as IPdfNativePageSize).height > 0;
}

function isCompactPageSizes(value: unknown): value is IPdfNativePageSizes {
    if (
        typeof value !== 'object'
        || value === null
        || Array.isArray(value)
        || !Number.isSafeInteger((value as IPdfNativePageSizes).pageCount)
        || (value as IPdfNativePageSizes).pageCount < 1
        || !isValidPageSize((value as IPdfNativePageSizes).defaultPageSize)
        || !Array.isArray((value as IPdfNativePageSizes).overrides)
        || (value as IPdfNativePageSizes).overrides.length > PDF_NATIVE_PAGE_SIZE_OVERRIDE_LIMIT
    ) {
        return false;
    }
    const pageCount = (value as IPdfNativePageSizes).pageCount;
    return (value as IPdfNativePageSizes).overrides.every((override) => (
        typeof override === 'object'
        && override !== null
        && Number.isSafeInteger(override.pageNumber)
        && override.pageNumber >= 1
        && override.pageNumber <= pageCount
        && isValidPageSize(override)
    ));
}

export function stagePdfOpeningPreview(options: {
    readonly documentFiles: TNativePreviewFiles;
    readonly geometryResolution: Promise<IPdfOpeningGeometryResolution>;
    readonly isCurrent: () => boolean;
    readonly openSurface: IDocumentOpenSurfaceSession;
    readonly source: IPdfPathSource;
    readonly traceContext?: Readonly<Record<string, unknown>>;
}): IStagedPdfOpeningPreview {
    let canceled = false;
    let disposed = false;
    let objectUrl: string | null = null;
    let source: ReturnType<typeof createNativePdfPreviewSourceFromPath> | null = null;
    let pageSource: IDocumentPageSource | null = null;
    let stopWatchingOpeningFrame: (() => void) | null = null;
    let stopWatchingSurface: (() => void) | null = null;
    let stopWatchingInvalidation: (() => void) | null = null;
    let stopWatchingNavigation: (() => void) | null = null;
    let stopWatchingTargetWidth: (() => void) | null = null;
    let resolveOpeningFrameWait: ((snapshot: IDocumentOpenSurfaceSnapshot | null) => void) | null = null;
    let generation: number | null = null;

    function cancelOpeningFrameWait() {
        const resolveWait = resolveOpeningFrameWait;
        resolveOpeningFrameWait = null;
        resolveWait?.(null);
        stopWatchingOpeningFrame?.();
        stopWatchingOpeningFrame = null;
    }

    function dispose(reason: string, clearPreview = true) {
        if (disposed) {
            return;
        }
        disposed = true;
        cancelOpeningFrameWait();
        stopWatchingSurface?.();
        stopWatchingSurface = null;
        stopWatchingInvalidation?.();
        stopWatchingInvalidation = null;
        stopWatchingNavigation?.();
        stopWatchingNavigation = null;
        stopWatchingTargetWidth?.();
        stopWatchingTargetWidth = null;
        resolveOpeningFrameWait?.(null);
        resolveOpeningFrameWait = null;
        if (clearPreview && generation !== null && objectUrl !== null) {
            options.openSurface.clearOpeningPagePreview(generation, objectUrl);
        }
        if (generation !== null && pageSource !== null) {
            options.openSurface.clearOpeningPageSource(generation, pageSource);
        }
        pageSource?.dispose();
        pageSource = null;
        source?.terminate();
        source = null;
        logPdfRenderTrace('pdf-open-native-preview-retired', {
            ...options.traceContext,
            reason,
        });
    }

    function waitForOpeningFrame(input: {
        documentId: string;
        openingGeometry: IPdfOpeningGeometry;
        pageNumber: number;
        sourceRevisionKey: string;
    }): Promise<IDocumentOpenSurfaceSnapshot | null> {
        // One preview attempt owns one generation-bound watcher. Replacement,
        // cancellation, and disposal all settle it through
        // cancelOpeningFrameWait, so no observer can survive its attempt.
        cancelOpeningFrameWait();
        let boundGeneration: number | null = null;
        const inspect = (snapshot: IDocumentOpenSurfaceSnapshot) => {
            if (
                canceled
                || disposed
                || !options.isCurrent()
            ) {
                return null;
            }
            if (!isOpeningTransitionPhase(snapshot.phase)) {
                return snapshot.identity?.documentId === input.documentId
                    && (snapshot.phase === 'ready' || snapshot.phase === 'failed')
                    ? null
                    : undefined;
            }
            if (snapshot.identity?.documentId !== input.documentId) {
                return undefined;
            }
            boundGeneration ??= snapshot.generation;
            if (snapshot.generation !== boundGeneration) {
                return null;
            }
            if (snapshot.openingPageGeometry === null && snapshot.phase === 'pending') {
                options.openSurface.commitOpeningPageGeometry(snapshot.generation, {
                    documentId: input.documentId,
                    ...input.openingGeometry,
                });
                return undefined;
            }
            const frame = snapshot.openingPageFrame;
            if (
                frame?.generation === boundGeneration
                && frame.pageNumber === input.pageNumber
                && frame.sourceRevisionKey === input.sourceRevisionKey
            ) {
                return snapshot;
            }
            return undefined;
        };
        const initial = inspect(options.openSurface.snapshot.value);
        if (initial !== undefined) {
            return Promise.resolve(initial);
        }
        return new Promise((resolve) => {
            let settled = false;
            const settle = (snapshot: IDocumentOpenSurfaceSnapshot | null) => {
                if (settled) {
                    return;
                }
                settled = true;
                stopWatchingOpeningFrame?.();
                stopWatchingOpeningFrame = null;
                resolveOpeningFrameWait = null;
                resolve(snapshot);
            };
            resolveOpeningFrameWait = settle;
            stopWatchingOpeningFrame = watch(
                () => options.openSurface.snapshot.value,
                (snapshot) => {
                    const result = inspect(snapshot);
                    if (result !== undefined) {
                        settle(result);
                    }
                },
                {flush: 'sync'},
            );
            const current = inspect(options.openSurface.snapshot.value);
            if (current !== undefined) {
                settle(current);
            }
        });
    }

    void (async () => {
        logPdfRenderTrace('pdf-open-native-preview-resolution-start', options.traceContext);
        const resolution = await options.geometryResolution;
        const shouldStage = shouldStageNativePdfOpeningPreview(options.source, resolution.openingGeometry);
        const resolvedSnapshot = options.openSurface.snapshot.value;
        logPdfRenderTrace('pdf-open-native-preview-resolution-end', {
            ...options.traceContext,
            canceled,
            current: options.isCurrent(),
            documentId: resolvedSnapshot.identity?.documentId ?? null,
            hasOpeningGeometry: resolution.openingGeometry !== null,
            hasSourceRevision: resolution.sourceRevision !== null,
            pageCount: resolution.openingGeometry?.pageCount ?? null,
            phase: resolvedSnapshot.phase,
            size: resolution.openingGeometry?.size ?? null,
            sourceSize: options.source.size,
            sourceRevisionDocumentId: resolution.sourceRevision?.documentId ?? null,
            shouldStage,
        });
        if (
            canceled
            || !options.isCurrent()
            || resolution.openingGeometry === null
            || resolution.sourceRevision === null
            || !shouldStage
        ) {
            return;
        }
        const openingGeometry = resolution.openingGeometry;
        const sourceRevision = resolution.sourceRevision;
        const sourceRevisionKey = `${String(sourceRevision.size)}:${String(sourceRevision.modifiedAt)}`;
        logPdfRenderTrace('pdf-open-native-preview-frame-wait-start', {
            ...options.traceContext,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        const snapshot = await waitForOpeningFrame({
            documentId: sourceRevision.documentId,
            openingGeometry,
            pageNumber: openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        generation = snapshot?.generation ?? null;
        logPdfRenderTrace('pdf-open-native-preview-frame-wait-end', {
            ...options.traceContext,
            generation,
            matched: snapshot !== null,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        if (snapshot === null || canceled || !options.isCurrent()) {
            return;
        }
        const activeGeneration = snapshot.generation;
        generation = activeGeneration;
        const previewSource = createNativePdfPreviewSourceFromPath(options.source.path, options.documentFiles);
        source = previewSource;
        const loadedPageSizes = await Promise.resolve(previewSource.getPageSizes()).catch(() => null);
        if (disposed || canceled || !options.isCurrent()) {
            dispose('surface-retired-during-page-sizes', false);
            return;
        }
        const fallbackPageSize = {
            width: openingGeometry.width,
            height: openingGeometry.height,
        };
        const pageCount = openingGeometry.pageCount;
        let pageSizes: readonly IPdfNativePageSize[] | null = null;
        let getPageSize = (_pageNumber: number): IPdfNativePageSize => fallbackPageSize;
        if (
            Array.isArray(loadedPageSizes)
            && loadedPageSizes.length === pageCount
            && loadedPageSizes.every(isValidPageSize)
        ) {
            pageSizes = loadedPageSizes;
            getPageSize = pageNumber => pageSizes?.[pageNumber - 1] ?? fallbackPageSize;
        } else if (
            isCompactPageSizes(loadedPageSizes)
            && loadedPageSizes.pageCount === pageCount
        ) {
            const overrides = new Map(
                loadedPageSizes.overrides.map(override => [
                    override.pageNumber,
                    override,
                ] as const),
            );
            getPageSize = pageNumber => overrides.get(pageNumber) ?? loadedPageSizes.defaultPageSize;
        }
        pageSource = pageSizes === null
            ? createPagePreviewDocumentSource({
                documentRef: sourceRevision.documentId,
                previewSource,
                pageCount,
                getPageSize,
                ownsPreviewSource: false,
            })
            : createPagePreviewDocumentSource({
                documentRef: sourceRevision.documentId,
                previewSource,
                pageSizes,
                ownsPreviewSource: false,
            });
        if (!options.openSurface.publishOpeningPageSource(
            activeGeneration,
            pageSource,
            () => dispose('surface-retired'),
        )) {
            dispose('source-rejected', false);
            return;
        }

        let nextRenderRevision = 0;
        let activeRender: {
            key: string;
            pageNumber: number;
            requestId: string;
        } | null = null;
        let committedRenderKey: string | null = null;
        async function renderPreview(pageNumber: number, reason: string) {
            if (disposed || canceled || !options.isCurrent()) {
                return false;
            }
            const boundedPage = Math.min(
                Math.max(1, Math.trunc(pageNumber)),
                pageCount,
            );
            const currentGeometry = options.openSurface.snapshot.value.openingPageGeometry
                ?? openingGeometry;
            const targetWidthPx = resolveTargetWidth(options.openSurface, currentGeometry);
            const renderKey = `${String(boundedPage)}:${String(targetWidthPx)}`;
            if (renderKey === activeRender?.key) {
                return false;
            }
            if (
                renderKey === committedRenderKey
                && options.openSurface.snapshot.value.openingPageFrame?.preview?.pageNumber
                === boundedPage
            ) {
                return true;
            }
            nextRenderRevision += 1;
            const renderRevision = nextRenderRevision;
            if (activeRender !== null) {
                previewSource.cancelPagePreview?.(
                    activeRender.pageNumber,
                    activeRender.requestId,
                );
            }
            const requestId = [
                'pdf-opening',
                activeGeneration,
                sourceRevisionKey,
                boundedPage,
                renderRevision,
            ].join(':');
            const pendingRender = {
                key: renderKey,
                pageNumber: boundedPage,
                requestId,
            };
            activeRender = pendingRender;
            logPdfRenderTrace('pdf-open-native-preview-submit', {
                ...options.traceContext,
                generation: activeGeneration,
                pageNumber: boundedPage,
                reason,
                sourceRevisionKey,
                targetWidthPx,
            });
            let rendered;
            try {
                rendered = await previewSource.renderPageObjectUrl(boundedPage, {
                    previewRequestId: requestId,
                    targetWidthPx,
                });
            } catch (error) {
                if (
                    disposed
                    || canceled
                    || !options.isCurrent()
                    || renderRevision !== nextRenderRevision
                ) {
                    return false;
                }
                throw error;
            } finally {
                if (activeRender === pendingRender) {
                    activeRender = null;
                }
            }
            if (
                disposed
                || canceled
                || !options.isCurrent()
                || renderRevision !== nextRenderRevision
            ) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const current = options.openSurface.snapshot.value;
            const currentRevision = current.identity?.documentRevision;
            if (
                current.generation !== activeGeneration
                || current.identity?.documentId !== sourceRevision.documentId
                || currentRevision === undefined
                || !isOpeningTransitionPhase(current.phase)
                || options.openSurface.viewportSession.value.requestedPage !== boundedPage
            ) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const pageSize = getPageSize(boundedPage);
            const nextGeometry = {
                ...openingGeometry,
                documentId: sourceRevision.documentId,
                pageNumber: boundedPage,
                pageCount,
                width: pageSize.width,
                height: pageSize.height,
                rotation: boundedPage === openingGeometry.pageNumber
                    ? openingGeometry.rotation
                    : 0 as const,
            };
            const geometryMatches = current.openingPageGeometry?.pageNumber === boundedPage
                && current.openingPageGeometry.width === nextGeometry.width
                && current.openingPageGeometry.height === nextGeometry.height;
            if (
                !geometryMatches
                && !options.openSurface.commitOpeningPageGeometry(activeGeneration, nextGeometry)
            ) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const accepted = options.openSurface.commitOpeningPagePreview(activeGeneration, {
                documentId: sourceRevision.documentId,
                documentRevision: currentRevision,
                objectUrl: rendered.objectUrl,
                pageNumber: boundedPage,
                renderedWidth: rendered.renderedPx,
                sourceRevisionKey,
            });
            if (!accepted) {
                previewSource.revokeObjectURL(rendered.objectUrl);
                return false;
            }
            const previousObjectUrl = objectUrl;
            stopWatchingInvalidation?.();
            objectUrl = rendered.objectUrl;
            stopWatchingInvalidation = rendered.onInvalidated?.(() => {
                if (generation === null || objectUrl !== rendered.objectUrl) {
                    return;
                }
                options.openSurface.clearOpeningPagePreview(generation, rendered.objectUrl);
                objectUrl = null;
                committedRenderKey = null;
                requestPreviewRender(
                    options.openSurface.viewportSession.value.requestedPage,
                    'memory-pressure-recovery',
                );
            }) ?? null;
            if (previousObjectUrl && previousObjectUrl !== rendered.objectUrl) {
                previewSource.revokeObjectURL(previousObjectUrl);
            }
            committedRenderKey = renderKey;
            logPdfRenderTrace('pdf-open-native-preview-committed', {
                ...options.traceContext,
                generation: activeGeneration,
                pageNumber: boundedPage,
                reason,
                renderedWidth: rendered.renderedPx,
                sourceRevisionKey,
            });
            return true;
        }

        function requestPreviewRender(pageNumber: number, reason: string) {
            void renderPreview(pageNumber, reason).catch((error: unknown) => {
                if (disposed || canceled) {
                    return;
                }
                logPdfRenderTrace('pdf-open-native-preview-failed', {
                    ...options.traceContext,
                    error: getErrorMessage(error),
                    reason,
                });
                dispose('render-failed');
            });
        }

        stopWatchingSurface = watch(
            () => {
                const live = options.openSurface.snapshot.value;
                return [
                    live.generation,
                    live.phase,
                ] as const;
            },
            ([
                liveGeneration,
                phase,
            ]) => {
                if (
                    liveGeneration !== activeGeneration
                    || phase === 'ready'
                    || phase === 'failed'
                ) {
                    dispose(phase === 'ready' ? 'pdfjs-handoff' : 'surface-changed', false);
                }
            },
            {flush: 'sync'},
        );
        stopWatchingNavigation = watch(
            () => options.openSurface.viewportSession.value.requestedPage,
            (pageNumber) => {
                if (
                    options.openSurface.snapshot.value.openingPageFrame?.preview?.pageNumber
                    !== pageNumber
                ) {
                    requestPreviewRender(pageNumber, 'navigation');
                }
            },
            {flush: 'sync'},
        );
        const initialRendered = await renderPreview(
            options.openSurface.viewportSession.value.requestedPage,
            'initial',
        );
        if (
            !initialRendered
            && !disposed
            && activeRender === null
            && options.openSurface.snapshot.value.openingPageFrame?.preview === undefined
        ) {
            dispose('initial-render-rejected', false);
        }
        if (disposed) {
            return;
        }
        stopWatchingTargetWidth = watch(
            () => options.openSurface.snapshot.value.openingPageFrame?.style.width ?? '',
            (_width, previousWidth) => {
                if (previousWidth) {
                    requestPreviewRender(
                        options.openSurface.viewportSession.value.requestedPage,
                        'viewport-scale',
                    );
                }
            },
            {flush: 'post'},
        );
    })().catch((error: unknown) => {
        if (!canceled) {
            logPdfRenderTrace('pdf-open-native-preview-failed', {
                ...options.traceContext,
                error: getErrorMessage(error),
            });
        }
        dispose(canceled ? 'canceled' : 'render-failed');
    });

    return Object.freeze({cancel(reason: string) {
        canceled = true;
        dispose(reason);
    }});
}
