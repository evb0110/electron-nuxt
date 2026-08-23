import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import { collectEmbeddedShapeAnnotationIds } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/collectEmbeddedShapeAnnotationIds';
import { refreshDeletedEmbeddedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/refreshDeletedEmbeddedShapePage';
import { rerenderRenderedManagedEmbeddedShapePages } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/rerenderRenderedManagedEmbeddedShapePages';
import { shouldRefreshManagedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/shouldRefreshManagedShapePage';
import { syncHiddenEmbeddedAnnotationDom as syncHiddenEmbeddedAnnotationDomForContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IGuardAsyncOptions } from '@app/utils/asyncGuard';
import { tryOnScopeDispose } from '@vueuse/core';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IShapeImportPlan,
    IShapeImportSource,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    acquireEmbeddedShapeImport,
    createEmbeddedShapeImportCacheKey,
} from '@app/modules/pdf-viewer/runtime/annotations/embeddedShapeImportCache';
import {
    isShapeSavePreparation,
    type IShapeSavePreparation,
} from '@app/modules/pdf-viewer/annotations/isShapeSavePreparation';

interface IManagedEmbeddedPdfShapesPageRange {
    start: number;
    end: number;
}

interface IManagedEmbeddedPdfShapesLogger {
    debug: (scope: string, message: string, payload?: unknown) => void;
    warn: (scope: string, message: string, payload?: unknown) => void;
}

interface IManagedEmbeddedPdfShapesRenderOptions {
    preserveRenderedPages?: boolean;
    forceRerender?: boolean;
    bufferOverride?: number;
}

interface IPendingPostPaintEmbeddedShapeImport {
    data: Uint8Array | null;
    path: string | null;
    revision: TDocumentRevisionToken | null;
    documentKey: string | null;
    token: number;
    visibleStart: number;
    visibleEnd: number;
}

/**
 * Rendering/persistence projection port. It owns no annotation semantics;
 * canonical shape identity, revisions, tombstones, the import baseline and the
 * save frontier all live in AnnotationStore behind these commands.
 */
export interface IManagedEmbeddedPdfShapeProjectionPort {
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys: () => string[];
    importEmbeddedShapes: (shapes: IShapeAnnotation[], source: IShapeImportSource) => IShapeImportPlan;
    resetShapeImportBaseline: () => void;
    isShapeImportBaselineReady: () => boolean;
    preservesShapeImportBaseline: (source: IShapeImportSource) => boolean;
    clearPendingShapeImportAdoption: () => void;
    beginShapeSave: (documentRevisionToken: TDocumentRevisionToken | null) => IShapeSavePreparation;
}

interface IUseManagedEmbeddedPdfShapesOptions {
    viewerContainer: Ref<HTMLElement | null>;
    originalPath?: Ref<string | null>;
    workingCopyPath: Ref<string | null>;
    sourcePdfData: Ref<Uint8Array | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    visibleRange: Ref<IManagedEmbeddedPdfShapesPageRange>;
    bufferPages: Ref<number>;
    shapeComposable: IManagedEmbeddedPdfShapeProjectionPort;
    /**
     * Normalized ids AnnotationStore reports as deleted, for every annotation
     * kind. Shapes are hidden because the app repaints them itself; these are
     * hidden because the user removed them and the file has not been rewritten
     * yet.
     */
    deletedEmbeddedAnnotationIds: Ref<ReadonlySet<string>>;
    logger: IManagedEmbeddedPdfShapesLogger;
    runGuardedTask: (
        task: () => Promise<unknown>,
        options: IGuardAsyncOptions,
    ) => void;
    nextTick: () => Promise<void>;
    isPageRendered: (pageNumber: number) => boolean;
    invalidatePages: (pages: number[]) => void;
    renderVisiblePages: (
        visibleRange: IManagedEmbeddedPdfShapesPageRange,
        renderOptions?: IManagedEmbeddedPdfShapesRenderOptions,
    ) => Promise<void>;
    hideManagedAnnotationEditors: (pageNumber?: number) => void;
    currentPage: Ref<number>;
}

export const useManagedEmbeddedPdfShapes = ({
    viewerContainer,
    originalPath,
    workingCopyPath,
    sourcePdfData,
    documentRevisionToken,
    visibleRange,
    bufferPages,
    shapeComposable,
    deletedEmbeddedAnnotationIds,
    logger,
    runGuardedTask,
    nextTick: waitForNextTick,
    isPageRendered,
    invalidatePages,
    renderVisiblePages,
    hideManagedAnnotationEditors,
    currentPage,
}: IUseManagedEmbeddedPdfShapesOptions) => {
    let embeddedShapeImportToken = 0;
    let pendingEmbeddedShapeImportData: Uint8Array | null = null;
    let pendingEmbeddedShapeImportPath: string | null = null;
    let pendingEmbeddedShapeImportRevision: TDocumentRevisionToken | null = null;
    let embeddedShapeImportPromise: Promise<void> = Promise.resolve();
    let embeddedShapeImportAbortController: AbortController | null = null;
    /**
     * In-flight save-priming parses, keyed by the document they belong to, so a
     * document swap can cancel the worker instead of paying for a scan whose
     * result the ownership fence would discard anyway.
     */
    const savePrimingAbortControllers = new Set<{
        controller: AbortController;
        path: string | null;
        documentKey: string | null;
    }>();
    const pendingEmbeddedAnnotationRefreshPages = new Set<number>();
    let isEmbeddedAnnotationRefreshScheduled = false;
    let isDeferredHiddenEmbeddedAnnotationDomSyncScheduled = false;
    let deferredHiddenAnnotationSyncFrame: number | null = null;
    let disposed = false;
    let pendingPostPaintImport: IPendingPostPaintEmbeddedShapeImport | null = null;
    let lastRenderedSource: {
        data: Uint8Array | null;
        path: string | null;
        revision: TDocumentRevisionToken | null;
        documentKey: string | null;
        token: number;
        pageNumber: number;
    } | null = null;
    let scheduledPostPaintImport: {
        captured: IPendingPostPaintEmbeddedShapeImport;
        pageNumber: number;
    } | null = null;

    function runAfterInitialVisualPaint(
        captured: IPendingPostPaintEmbeddedShapeImport,
        pageNumber: number,
        task: (canvasStillMounted: boolean) => void,
    ) {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            setTimeout(() => {
                if (isCapturedImportCurrent(captured)) {
                    task(hasRenderedCanvasOnPage(pageNumber));
                }
            }, 0);
            return;
        }

        let remainingPaintFrames = 2;
        const waitForFrame = () => {
            if (!isCapturedImportCurrent(captured)) {
                return;
            }
            remainingPaintFrames -= 1;
            if (remainingPaintFrames <= 0) {
                setTimeout(() => {
                    if (isCapturedImportCurrent(captured)) {
                        task(hasRenderedCanvasOnPage(pageNumber));
                    }
                }, 0);
                return;
            }
            window.requestAnimationFrame(waitForFrame);
        };
        window.requestAnimationFrame(waitForFrame);
    }

    function isCapturedImportCurrent(captured: IPendingPostPaintEmbeddedShapeImport) {
        return !disposed
            && embeddedShapeImportToken === captured.token
            && sourcePdfData.value === captured.data
            && workingCopyPath.value === captured.path
            && documentRevisionToken.value === captured.revision
            && (originalPath?.value ?? null) === captured.documentKey;
    }

    function scheduleCapturedImportAfterRenderedPage(
        captured: IPendingPostPaintEmbeddedShapeImport,
        pageNumber: number,
    ) {
        if (
            !isCapturedImportCurrent(captured)
            || pageNumber < captured.visibleStart
            || pageNumber > captured.visibleEnd
            || scheduledPostPaintImport?.captured === captured
        ) {
            return;
        }
        scheduledPostPaintImport = {
            captured,
            pageNumber,
        };
        runAfterInitialVisualPaint(captured, pageNumber, (canvasStillMounted) => {
            if (
                scheduledPostPaintImport?.captured === captured
                && scheduledPostPaintImport.pageNumber === pageNumber
            ) {
                scheduledPostPaintImport = null;
            }
            if (!canvasStillMounted || pendingPostPaintImport !== captured) {
                return;
            }
            pendingPostPaintImport = null;
            runGuardedTask(() => ensureManagedShapeBaselineReady(), {
                category: 'background-diagnostic',
                scope: 'pdf-shapes',
                message: 'Failed to import managed shapes after initial PDF paint',
            });
        });
    }

    function currentImportSource(path: string | null) {
        return {
            documentKey: originalPath?.value ?? null,
            path,
        };
    }

    const managedEmbeddedAnnotationIds = computed(() =>
        collectEmbeddedShapeAnnotationIds(shapeComposable.getAllShapes()),
    );
    const normalizedManagedEmbeddedAnnotationIds = computed(() => {
        const ids = new Set<string>();
        managedEmbeddedAnnotationIds.value.forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                ids.add(normalizedId);
            }
        });
        return ids;
    });
    const hiddenEmbeddedAnnotationIds = computed(() => {
        const ids = new Set(normalizedManagedEmbeddedAnnotationIds.value);
        deletedEmbeddedAnnotationIds.value.forEach(id => ids.add(id));
        return ids;
    });

    const renderHiddenEmbeddedAnnotationIds = computed(() => {
        // The SVG overlay is the app-rendered source of truth for managed shapes.
        // Suppress their native PDF canvas paint immediately so PDF border widths
        // cannot briefly appear zoom-scaled before the overlay is mounted.
        return new Set(hiddenEmbeddedAnnotationIds.value);
    });

    function queueDeferredHiddenEmbeddedAnnotationDomSync() {
        if (disposed || isDeferredHiddenEmbeddedAnnotationDomSyncScheduled) {
            return;
        }

        isDeferredHiddenEmbeddedAnnotationDomSyncScheduled = true;
        const runDeferredSync = () => {
            deferredHiddenAnnotationSyncFrame = null;
            isDeferredHiddenEmbeddedAnnotationDomSyncScheduled = false;
            if (disposed) {
                return;
            }
            syncHiddenEmbeddedAnnotationDom({ retryDeferredManagedAnnotations: false });
            hideManagedAnnotationEditors();
        };

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            deferredHiddenAnnotationSyncFrame = window.requestAnimationFrame(runDeferredSync);
            return;
        }

        void waitForNextTick().then(runDeferredSync);
    }

    function syncHiddenEmbeddedAnnotationDom(options?: { retryDeferredManagedAnnotations?: boolean }) {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }

        const result = syncHiddenEmbeddedAnnotationDomForContainer({
            container,
            hiddenAnnotationIds: renderHiddenEmbeddedAnnotationIds.value,
            managedAnnotationIds: normalizedManagedEmbeddedAnnotationIds.value,
        });
        if (
            options?.retryDeferredManagedAnnotations !== false
            && result.deferredManagedAnnotationCount > 0
        ) {
            queueDeferredHiddenEmbeddedAnnotationDomSync();
        }
    }

    function hasRenderedViewerCanvas() {
        return Boolean(
            viewerContainer.value?.querySelector('.page_container--rendered .page_canvas canvas'),
        );
    }

    function hasRenderedCanvasOnPage(pageNumber: number) {
        return Boolean(
            viewerContainer.value?.querySelector(
                `.page_container[data-page="${pageNumber}"] .page_canvas canvas`,
            ),
        );
    }

    async function resetEmbeddedShapeImportBaseline(
        token?: number,
        path?: string | null,
        revision?: TDocumentRevisionToken | null,
    ) {
        shapeComposable.resetShapeImportBaseline();
        await waitForNextTick();
        if (token !== undefined && isStaleEmbeddedShapeImport(token, path ?? null, revision ?? null)) {
            logStaleEmbeddedShapeImport(token, path ?? null, revision ?? null);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();
    }

    async function importEmbeddedShapesFromResolvedSource(
        data: Uint8Array | null,
        path: string | null,
        revision: TDocumentRevisionToken | null,
        token: number,
        signal: AbortSignal,
    ): Promise<
        | { status: 'empty' }
        | { status: 'failed' }
        | { status: 'stale' }
        | { status: 'unscannable' }
        | {
            status: 'imported';
            shapes: IShapeAnnotation[]
        }
    > {
        try {
            // Raw PDF-name scans are only positive hints. Object streams can
            // compress /Annots, /EVBShapeKey, and /Subtype names, so a negative
            // byte scan must never establish an authoritative empty baseline.
            if ((!data || data.length === 0) && !path) {
                return { status: 'empty' };
            }
            if (isStaleEmbeddedShapeImport(token, path, revision)) {
                logStaleEmbeddedShapeImport(token, path, revision);
                return { status: 'stale' };
            }
            // The original path is not a renderer-readable source. Cache and
            // worker identity are therefore derived only from the adopted
            // working copy/data plus the document revision token.
            const documentKey = originalPath?.value ?? null;
            const stableSourceIdentity = documentKey && revision !== null
                ? JSON.stringify([
                    documentKey,
                    revision,
                ])
                : null;
            const key = createEmbeddedShapeImportCacheKey({
                data,
                path,
                documentRevisionToken: revision,
                stableSourceIdentity,
            });
            const shapes = await acquireEmbeddedShapeImport(key, async (sharedSignal) => {
                const {
                    importEmbeddedShapeAnnotationsFromPathInWorker,
                    importEmbeddedShapeAnnotationsUsingWorker,
                } = await import(
                    '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient'
                );
                return data && data.length > 0
                    ? importEmbeddedShapeAnnotationsUsingWorker(data, {signal: sharedSignal})
                    : importEmbeddedShapeAnnotationsFromPathInWorker(path!, {signal: sharedSignal});
            }, signal);
            if (isStaleEmbeddedShapeImport(token, path, revision)) {
                logStaleEmbeddedShapeImport(token, path, revision);
                return { status: 'stale' };
            }
            return {
                status: 'imported',
                shapes,
            };
        } catch (error) {
            if (signal.aborted || isStaleEmbeddedShapeImport(token, path, revision)) {
                return { status: 'stale' };
            }
            // A size refusal is a resource policy, not a defective document: the
            // shape layer stays unscanned and the session keeps saving, with the
            // shape rewrite disabled so unseen managed shapes survive untouched.
            if (error instanceof RangeError) {
                logger.warn('pdf-shapes', 'Embedded PDF shape layer is too large to scan; leaving it unmanaged', error);
                return { status: 'unscannable' };
            }
            logger.warn('pdf-shapes', 'Failed to import embedded PDF shapes', error);
            return { status: 'failed' };
        }
    }

    function isStaleEmbeddedShapeImport(
        token: number,
        path: string | null,
        revision: TDocumentRevisionToken | null,
    ) {
        // Completed imports are cached per revision, but an in-flight one is
        // only fenced by what it captured when it started. Without the revision
        // an old scan can land after a page mutation and reinstate the shape
        // layer of the document that mutation replaced.
        return disposed
            || embeddedShapeImportToken !== token
            || workingCopyPath.value !== path
            || documentRevisionToken.value !== revision;
    }

    function logStaleEmbeddedShapeImport(
        token: number,
        path: string | null,
        revision: TDocumentRevisionToken | null,
    ) {
        logger.debug('pdf-shapes', 'Skipped stale embedded shape import result', () => ({
            path,
            token,
            revision,
            currentToken: embeddedShapeImportToken,
            currentRevision: documentRevisionToken.value,
            samePath: workingCopyPath.value === path,
        }));
    }

    async function applyImportedEmbeddedShapes(
        importedShapes: IShapeAnnotation[],
        path: string | null,
        token: number,
        revision: TDocumentRevisionToken | null,
    ) {
        const currentShapeCountBeforeApply = shapeComposable.getAllShapes().length;
        const applyPlan = shapeComposable.importEmbeddedShapes(importedShapes, currentImportSource(path));

        logger.debug('pdf-shapes', 'Embedded shape import finished', () => ({
            path,
            token,
            importedShapeCount: importedShapes.length,
            importMode: applyPlan.mode,
            importReason: applyPlan.reason,
            skipRerender: applyPlan.skipRerender,
            currentShapeCountBeforeApply,
        }));

        await waitForNextTick();
        if (isStaleEmbeddedShapeImport(token, path, revision)) {
            logStaleEmbeddedShapeImport(token, path, revision);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();

        return applyPlan;
    }

    async function rerenderManagedEmbeddedShapesIfNeeded() {
        if (!hasRenderedViewerCanvas()) {
            logPdfRenderTrace('managed-shapes-rerender-skip-no-canvas', {
                currentPage: currentPage.value,
                visibleRange: visibleRange.value,
                shapeCount: shapeComposable.getAllShapes().length,
            });
            return;
        }

        logPdfRenderTrace('managed-shapes-rerender-check', {
            currentPage: currentPage.value,
            visibleRange: visibleRange.value,
            renderBuffer: bufferPages.value,
            shapeCount: shapeComposable.getAllShapes().length,
        });
        await rerenderRenderedManagedEmbeddedShapePages({
            shapes: shapeComposable.getAllShapes(),
            visibleRange: visibleRange.value,
            renderBuffer: bufferPages.value,
            isPageRendered,
            invalidatePages,
            renderVisiblePages,
        });
    }

    function importEmbeddedShapesForSource(
        data: Uint8Array | null,
        path: string | null,
        revision: TDocumentRevisionToken | null,
    ) {
        if (disposed) {
            return Promise.resolve();
        }
        cancelSupersededShapeSavePriming();
        pendingEmbeddedShapeImportData = data;
        pendingEmbeddedShapeImportPath = path;
        pendingEmbeddedShapeImportRevision = revision;
        embeddedShapeImportAbortController?.abort();
        const abortController = new AbortController();
        embeddedShapeImportAbortController = abortController;
        const localToken = ++embeddedShapeImportToken;

        const request = {promise: null as Promise<void> | null};
        const importPromise = (async () => {
            logPdfRenderTrace('managed-shapes-import-start', {
                path,
                hasData: Boolean(data),
                dataBytes: data?.byteLength ?? 0,
                token: localToken,
                currentPage: currentPage.value,
                visibleRange: visibleRange.value,
            });
            logger.debug('pdf-shapes', 'Importing embedded shapes for source', () => ({
                path,
                hasData: Boolean(data),
                dataBytes: data?.byteLength ?? 0,
                token: localToken,
                hasBaseline: shapeComposable.isShapeImportBaselineReady(),
                currentShapeCount: shapeComposable.getAllShapes().length,
            }));
            if ((!data || data.length === 0) && !path) {
                await resetEmbeddedShapeImportBaseline(localToken, path, revision);
                return;
            }

            const result = await importEmbeddedShapesFromResolvedSource(
                data,
                path,
                revision,
                localToken,
                abortController.signal,
            );
            if (result.status === 'empty') {
                await resetEmbeddedShapeImportBaseline(localToken, path, revision);
                return;
            }
            if (result.status === 'failed') {
                shapeComposable.clearPendingShapeImportAdoption();
                throw new Error('Failed to establish embedded PDF shape baseline');
            }
            if (result.status === 'unscannable') {
                // No baseline is established, so the document stays openable and
                // savable while every shape write stays additive.
                shapeComposable.clearPendingShapeImportAdoption();
                return;
            }
            if (result.status === 'stale') {
                return;
            }
            if (isStaleEmbeddedShapeImport(localToken, path, revision)) {
                logStaleEmbeddedShapeImport(localToken, path, revision);
                return;
            }

            const applyPlan = await applyImportedEmbeddedShapes(result.shapes, path, localToken, revision);
            if (isStaleEmbeddedShapeImport(localToken, path, revision)) {
                logStaleEmbeddedShapeImport(localToken, path, revision);
                return;
            }
            if (!applyPlan?.skipRerender) {
                await rerenderManagedEmbeddedShapesIfNeeded();
            }
            logPdfRenderTrace('managed-shapes-import-end', {
                path,
                token: localToken,
                currentPage: currentPage.value,
                visibleRange: visibleRange.value,
                shapeCount: shapeComposable.getAllShapes().length,
                skippedRerender: applyPlan?.skipRerender === true,
            });
        })();

        const cachedPromise = importPromise.catch((error: unknown) => {
            if (
                embeddedShapeImportPromise === request.promise
                && embeddedShapeImportToken === localToken
                && pendingEmbeddedShapeImportData === data
                && pendingEmbeddedShapeImportPath === path
                && pendingEmbeddedShapeImportRevision === revision
            ) {
                // Clear only the rejected request. A newer source/import may
                // already own the cache and must not be disturbed.
                pendingEmbeddedShapeImportData = null;
                pendingEmbeddedShapeImportPath = null;
                pendingEmbeddedShapeImportRevision = null;
                embeddedShapeImportPromise = Promise.resolve();
                if (embeddedShapeImportAbortController === abortController) {
                    embeddedShapeImportAbortController = null;
                }
            }
            throw error;
        }).finally(() => {
            if (embeddedShapeImportAbortController === abortController) {
                embeddedShapeImportAbortController = null;
            }
        });
        request.promise = cachedPromise;
        embeddedShapeImportPromise = cachedPromise;

        return embeddedShapeImportPromise;
    }

    function ensureEmbeddedShapesImportedForCurrentSource() {
        const data = sourcePdfData.value;
        const path = workingCopyPath.value;
        const revision = documentRevisionToken.value;
        if (
            pendingEmbeddedShapeImportData !== data
            || pendingEmbeddedShapeImportPath !== path
            || pendingEmbeddedShapeImportRevision !== revision
        ) {
            return importEmbeddedShapesForSource(data, path, revision);
        }
        return embeddedShapeImportPromise;
    }

    /**
     * Resolves to whether this session knows the document's whole shape layer.
     * A `false` result is not an error: the layer was too large to scan, so
     * callers must keep shape writes additive instead of rewriting the layer.
     */
    async function ensureManagedShapeBaselineReady() {
        if (!sourcePdfData.value && !workingCopyPath.value) {
            return true;
        }
        const data = sourcePdfData.value;
        const path = workingCopyPath.value;
        const revision = documentRevisionToken.value;
        await ensureEmbeddedShapesImportedForCurrentSource();
        if (disposed) {
            // Disposal says nothing about the shape layer, and a save racing it
            // is rejected by its own staleness guards.
            return true;
        }
        if (
            sourcePdfData.value !== data
            || workingCopyPath.value !== path
            || documentRevisionToken.value !== revision
        ) {
            throw new Error('PDF source changed while establishing embedded shape baseline');
        }
        return shapeComposable.isShapeImportBaselineReady();
    }

    async function clearManagedShapesForDeferredImport() {
        embeddedShapeImportAbortController?.abort();
        embeddedShapeImportAbortController = null;
        pendingPostPaintImport = null;
        scheduledPostPaintImport = null;
        const localToken = ++embeddedShapeImportToken;
        const path = workingCopyPath.value;
        const revision = documentRevisionToken.value;
        shapeComposable.resetShapeImportBaseline();
        await waitForNextTick();
        if (isStaleEmbeddedShapeImport(localToken, path, revision)) {
            logStaleEmbeddedShapeImport(localToken, path, revision);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();
    }

    function queueCurrentSourceImportAfterInitialPaint() {
        const data = sourcePdfData.value;
        const path = workingCopyPath.value;
        if (!data && !path) {
            pendingPostPaintImport = null;
            scheduledPostPaintImport = null;
            return false;
        }
        const captured: IPendingPostPaintEmbeddedShapeImport = {
            data,
            path,
            revision: documentRevisionToken.value,
            documentKey: originalPath?.value ?? null,
            token: embeddedShapeImportToken,
            visibleStart: visibleRange.value.start,
            visibleEnd: visibleRange.value.end,
        };
        const pending = pendingPostPaintImport;
        if (
            pending
            && pending.data === captured.data
            && pending.path === captured.path
            && pending.revision === captured.revision
            && pending.documentKey === captured.documentKey
            && pending.token === captured.token
        ) {
            return true;
        }
        pendingPostPaintImport = captured;
        const rendered = lastRenderedSource;
        const sameRenderedDocument = rendered && (
            captured.documentKey !== null
                ? rendered.documentKey === captured.documentKey
                : rendered.data === captured.data
                    && rendered.path === captured.path
                    && rendered.revision === captured.revision
        );
        if (sameRenderedDocument && hasRenderedCanvasOnPage(rendered.pageNumber)) {
            scheduleCapturedImportAfterRenderedPage(captured, rendered.pageNumber);
        }
        return true;
    }

    /**
     * Cancels every save-priming parse whose document the viewer no longer
     * holds. Priming that still belongs to the current document survives: a
     * save legitimately republishes the same working copy.
     */
    function cancelSupersededShapeSavePriming() {
        savePrimingAbortControllers.forEach((registration) => {
            if (isStaleShapeSavePriming(registration.path, registration.documentKey)) {
                registration.controller.abort(
                    new DOMException('Managed shape save priming was superseded', 'AbortError'),
                );
            }
        });
    }

    /**
     * The document a save-priming parse belongs to. The revision token is not
     * part of it: a successful save rewrites the working copy and publishes a
     * new revision, and the native route primes from the bytes that write
     * produced. Identity is therefore the working copy and the document key,
     * both of which survive a save and both of which change when the viewer
     * adopts a different document.
     */
    function isStaleShapeSavePriming(path: string | null, documentKey: string | null) {
        return disposed
            || workingCopyPath.value !== path
            || (originalPath?.value ?? null) !== documentKey;
    }

    async function preparePersistedManagedShapesForSave(
        data: Uint8Array,
    ): Promise<IShapeSavePreparation | null> {
        const path = workingCopyPath.value;
        const documentKey = originalPath?.value ?? null;
        // The store captures the frontier this priming may advance past, so a
        // failed persist rolls the canonical shapes back atomically instead of
        // restoring a locally held snapshot.
        const preparation = shapeComposable.beginShapeSave(documentRevisionToken.value);
        const registration = {
            controller: new AbortController(),
            path,
            documentKey,
        };
        savePrimingAbortControllers.add(registration);

        const abandon = (message: string, detail: Record<string, unknown> = {}) => {
            preparation.rollback();
            logger.debug('pdf-shapes', message, () => ({
                path,
                documentKey,
                ...detail,
            }));
            return null;
        };

        try {
            if (disposed) {
                return abandon('Skipped managed shape save priming after disposal');
            }
            // The saved bytes may use compressed object streams. Always parse
            // them before adopting the persisted shape baseline; raw-name
            // absence is not evidence that the document is shape-free. The
            // worker client owns that parse: it keeps the whole-document scan
            // off the renderer thread and applies the same size guard as an
            // open-time import. Ownership stays here because these bytes are
            // still on their way to disk, so the worker gets a copy.
            const { importEmbeddedShapeAnnotationsUsingWorker } = await import(
                '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient'
            );
            const importedShapes = await importEmbeddedShapeAnnotationsUsingWorker(data, {
                transferOwnership: false,
                signal: registration.controller.signal,
            });
            if (isStaleShapeSavePriming(path, documentKey)) {
                return abandon('Skipped managed shape save priming for a replaced document', {
                    currentPath: workingCopyPath.value,
                    currentDocumentKey: originalPath?.value ?? null,
                });
            }
            // A replacement store, or a frontier it never issued, rejects the
            // priming. Reporting that as a prepared save would let the caller
            // mark shapes the file does not carry as clean.
            if (!preparation.primePersistedShapes(importedShapes)) {
                return abandon('Skipped managed shape save priming for a retired save frontier', {importedShapeCount: importedShapes.length});
            }
            await waitForNextTick();
            syncHiddenEmbeddedAnnotationDom();

            logger.debug('pdf-shapes', 'Prepared managed shapes from saved PDF bytes before persistence', () => ({
                importedShapeCount: importedShapes.length,
                currentShapeCount: shapeComposable.getAllShapes().length,
            }));

            return preparation;
        } catch (error) {
            preparation.rollback();
            if (registration.controller.signal.aborted) {
                logger.debug('pdf-shapes', 'Cancelled managed shape save priming', () => ({
                    path,
                    documentKey,
                }));
                return null;
            }
            if (error instanceof RangeError) {
                // A size refusal is a resource policy, not a broken save: the
                // shape baseline stays unknown and the save stays additive.
                logger.warn('pdf-shapes', 'Saved PDF is too large to scan for managed shapes; leaving the shape baseline unprimed', error);
                return null;
            }
            logger.warn('pdf-shapes', 'Failed to prepare managed shapes from saved PDF bytes', error);
            return null;
        } finally {
            savePrimingAbortControllers.delete(registration);
        }
    }

    async function restorePreparedManagedShapesAfterFailedSave(preparedRollback: unknown) {
        if (!isShapeSavePreparation(preparedRollback)) {
            return;
        }

        if (!preparedRollback.rollback()) {
            // The document can be replaced while a failed save unwinds, which
            // retires the store that captured this frontier. There is then
            // nothing to roll back, and nothing this viewer may touch.
            logger.debug('pdf-shapes', 'Skipped managed shape rollback for a retired save frontier', () => ({path: workingCopyPath.value}));
            return;
        }
        await waitForNextTick();
        syncHiddenEmbeddedAnnotationDom();
    }

    async function flushEmbeddedAnnotationPageRefresh() {
        if (isEmbeddedAnnotationRefreshScheduled) {
            return;
        }

        isEmbeddedAnnotationRefreshScheduled = true;

        try {
            await waitForNextTick();

            while (pendingEmbeddedAnnotationRefreshPages.size > 0) {
                const pageNumbers = Array.from(pendingEmbeddedAnnotationRefreshPages)
                    .sort((left, right) => left - right);
                pendingEmbeddedAnnotationRefreshPages.clear();

                const pagesToRefresh = pageNumbers.filter(pageNumber => shouldRefreshManagedShapePage({
                    pageNumber,
                    visibleRange: visibleRange.value,
                    renderBuffer: bufferPages.value,
                    isPageRendered,
                    hasRenderedCanvasDom: hasRenderedCanvasOnPage,
                }));
                if (pagesToRefresh.length === 0) {
                    continue;
                }

                await renderVisiblePages(
                    {
                        start: pagesToRefresh[0]!,
                        end: pagesToRefresh[pagesToRefresh.length - 1]!,
                    },
                    {
                        preserveRenderedPages: true,
                        forceRerender: true,
                        bufferOverride: 0,
                    },
                );
            }
        } finally {
            isEmbeddedAnnotationRefreshScheduled = false;

            if (pendingEmbeddedAnnotationRefreshPages.size > 0) {
                runGuardedTask(() => flushEmbeddedAnnotationPageRefresh(), {
                    category: 'background-diagnostic',
                    scope: 'pdf-shapes',
                    message: 'Failed to refresh embedded annotation pages',
                });
            }
        }
    }

    function queueEmbeddedAnnotationPageRefresh(pageNumber: number) {
        if (disposed || !Number.isFinite(pageNumber) || pageNumber < 1) {
            return;
        }

        pendingEmbeddedAnnotationRefreshPages.add(Math.floor(pageNumber));
        runGuardedTask(() => flushEmbeddedAnnotationPageRefresh(), {
            category: 'background-diagnostic',
            scope: 'pdf-shapes',
            message: 'Failed to refresh embedded annotation pages',
        });
    }

    function refreshHiddenAnnotationPage(comment: { pageNumber?: number | null }) {
        const pageNumber = Number.isFinite(comment.pageNumber) && (comment.pageNumber ?? 0) > 0
            ? Math.floor(comment.pageNumber!)
            : currentPage.value;
        queueEmbeddedAnnotationPageRefresh(pageNumber);
    }

    function refreshDeletedEmbeddedShape(shape: IShapeAnnotation | null) {
        logger.debug('pdf-shapes', 'Refreshing deleted embedded shape page', () => ({
            shapeId: shape?.id ?? null,
            source: shape?.source ?? null,
            annotationId: shape?.annotationId ?? null,
            stableKey: shape?.stableKey ?? null,
            pageIndex: shape?.pageIndex ?? null,
            deletedAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds(),
            deletedStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys(),
        }));
        refreshDeletedEmbeddedShapePage({
            shape,
            viewerContainer: viewerContainer.value,
            syncHiddenEmbeddedAnnotationDom,
            rerenderEmbeddedShapePage: queueEmbeddedAnnotationPageRefresh,
        });
    }

    function settleViewerLoadSettledWithManagedShapes(
        token: number,
        settleViewerLoadSettle: (token: number) => void,
    ) {
        if (queueCurrentSourceImportAfterInitialPaint()) {
            logger.debug('pdf-shapes', 'Deferring managed shape import until after initial PDF paint', {
                token,
                path: workingCopyPath.value,
            });
            settleViewerLoadSettle(token);
            return;
        }
        // The source can be published after the viewer load state. The source
        // watcher will queue it against the already committed document paint.
        settleViewerLoadSettle(token);
    }

    function syncAfterPageRendered(pageNumber: number) {
        lastRenderedSource = {
            data: sourcePdfData.value,
            path: workingCopyPath.value,
            revision: documentRevisionToken.value,
            documentKey: originalPath?.value ?? null,
            token: embeddedShapeImportToken,
            pageNumber,
        };
        if (pendingPostPaintImport) {
            scheduleCapturedImportAfterRenderedPage(pendingPostPaintImport, pageNumber);
        }
        syncHiddenEmbeddedAnnotationDom();
        hideManagedAnnotationEditors(pageNumber);
    }

    watch(hiddenEmbeddedAnnotationIds, (hiddenIds, previouslyHiddenIds) => {
        
        // Suppression removes the element from the annotation layer outright, so
        // an id leaving the set cannot be repaired by syncing again — the page has
        // to repaint from the document. Undoing a delete is the path that gets
        // here, and only a rendered page can hold the annotation, which is what
        // the refresh queue already filters for.
        if (previouslyHiddenIds && Array.from(previouslyHiddenIds).some(id => !hiddenIds.has(id))) {
            const buffer = Math.max(0, bufferPages.value);
            const firstPage = Math.max(1, visibleRange.value.start - buffer);
            for (let pageNumber = firstPage; pageNumber <= visibleRange.value.end + buffer; pageNumber += 1) {
                queueEmbeddedAnnotationPageRefresh(pageNumber);
            }
        }
        const localToken = embeddedShapeImportToken;
        const path = workingCopyPath.value;
        const revision = documentRevisionToken.value;
        void waitForNextTick().then(() => {
            if (isStaleEmbeddedShapeImport(localToken, path, revision)) {
                logStaleEmbeddedShapeImport(localToken, path, revision);
                return;
            }
            syncHiddenEmbeddedAnnotationDom();
            hideManagedAnnotationEditors();
        });
    });

    watch(
        () => [
            sourcePdfData.value,
            workingCopyPath.value,
            documentRevisionToken.value,
        ] as const,
        async ([
            data,
            path,
            ,
        ]) => {
            if (!data && !path) {
                if (
                    pendingPostPaintImport
                    || pendingEmbeddedShapeImportData
                    || pendingEmbeddedShapeImportPath
                    || shapeComposable.isShapeImportBaselineReady()
                ) {
                    await clearManagedShapesForDeferredImport();
                }
                return;
            }
            logger.debug('pdf-shapes', 'Queued managed shape import for deferred path-backed source', {
                path,
                hasBaseline: shapeComposable.isShapeImportBaselineReady(),
            });
            if (!shapeComposable.preservesShapeImportBaseline(currentImportSource(path))) {
                await clearManagedShapesForDeferredImport();
            }
            queueCurrentSourceImportAfterInitialPaint();
        },
        { immediate: true },
    );

    tryOnScopeDispose(() => {
        disposed = true;
        embeddedShapeImportAbortController?.abort();
        embeddedShapeImportAbortController = null;
        savePrimingAbortControllers.forEach(registration => registration.controller.abort(
            new DOMException('Managed shape save priming was disposed', 'AbortError'),
        ));
        pendingPostPaintImport = null;
        scheduledPostPaintImport = null;
        embeddedShapeImportToken += 1;
        pendingEmbeddedAnnotationRefreshPages.clear();
        if (deferredHiddenAnnotationSyncFrame !== null && typeof window !== 'undefined') {
            window.cancelAnimationFrame(deferredHiddenAnnotationSyncFrame);
            deferredHiddenAnnotationSyncFrame = null;
        }
        isDeferredHiddenEmbeddedAnnotationDomSyncScheduled = false;
    });

    return {
        managedEmbeddedAnnotationIds,
        hiddenEmbeddedAnnotationIds,
        renderHiddenEmbeddedAnnotationIds,
        syncHiddenEmbeddedAnnotationDom,
        refreshHiddenAnnotationPage,
        refreshDeletedEmbeddedShape,
        settleViewerLoadSettledWithManagedShapes,
        ensureManagedShapeBaselineReady,
        preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave,
        syncAfterPageRendered,
    };
};
