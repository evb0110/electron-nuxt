import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import { collectEmbeddedShapeAnnotationIds } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/collectEmbeddedShapeAnnotationIds';
import { refreshDeletedEmbeddedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/refreshDeletedEmbeddedShapePage';
import { rerenderRenderedManagedEmbeddedShapePages } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/rerenderRenderedManagedEmbeddedShapePages';
import { shouldRefreshManagedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/shouldRefreshManagedShapePage';
import { syncHiddenEmbeddedAnnotationDom as syncHiddenEmbeddedAnnotationDomForContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
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
    deletedEmbeddedAnnotationIds: { readonly value: ReadonlySet<string> };
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys: () => string[];
    importEmbeddedShapes: (shapes: IShapeAnnotation[], source: IShapeImportSource) => IShapeImportPlan;
    resetShapeImportBaseline: () => void;
    isShapeImportBaselineReady: () => boolean;
    preservesShapeImportBaseline: (source: IShapeImportSource) => boolean;
    clearPendingShapeImportAdoption: () => void;
    beginShapeSave: () => IManagedEmbeddedPdfShapeSavePreparation;
}

/**
 * Preparation is bound to the store and frontier that started the save. Its
 * priming step can only reconcile persistence identity, and rollback conditionally
 * removes that metadata without touching authored state.
 */
interface IManagedEmbeddedPdfShapeSavePreparation {
    primePersistedShapes: (shapes: IShapeAnnotation[]) => boolean;
    rollback: () => boolean;
}

/** The prepared save token crosses the workspace expose boundary as `unknown`. */
function isPreparedShapeSave(value: unknown): value is IManagedEmbeddedPdfShapeSavePreparation {
    return typeof value === 'object'
        && value !== null
        && 'rollback' in value
        && typeof value.rollback === 'function';
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
    const pendingDeletedEmbeddedShapeRefreshPages = new Set<number>();
    let isDeletedEmbeddedShapeRefreshScheduled = false;
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
    const forceHiddenEmbeddedAnnotationIds = computed(() => {
        const ids = new Set<string>();
        shapeComposable.deletedEmbeddedAnnotationIds.value.forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                ids.add(normalizedId);
            }
        });
        return ids;
    });

    const hiddenEmbeddedAnnotationIds = computed(() => {
        const ids = new Set(normalizedManagedEmbeddedAnnotationIds.value);
        forceHiddenEmbeddedAnnotationIds.value.forEach(id => ids.add(id));
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

    async function resetEmbeddedShapeImportBaseline(token?: number, path?: string | null) {
        shapeComposable.resetShapeImportBaseline();
        await waitForNextTick();
        if (token !== undefined && isStaleEmbeddedShapeImport(token, path ?? null)) {
            logStaleEmbeddedShapeImport(token, path ?? null);
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
            if (isStaleEmbeddedShapeImport(token, path)) {
                logStaleEmbeddedShapeImport(token, path);
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
                    : importEmbeddedShapeAnnotationsFromPathInWorker(
                        path!,
                        {signal: sharedSignal},
                    );
            }, signal);
            if (isStaleEmbeddedShapeImport(token, path)) {
                logStaleEmbeddedShapeImport(token, path);
                return { status: 'stale' };
            }
            return {
                status: 'imported',
                shapes,
            };
        } catch (error) {
            if (signal.aborted || isStaleEmbeddedShapeImport(token, path)) {
                return { status: 'stale' };
            }
            logger.warn('pdf-shapes', 'Failed to import embedded PDF shapes', error);
            return { status: 'failed' };
        }
    }

    function isStaleEmbeddedShapeImport(token: number, path: string | null) {
        return disposed
            || embeddedShapeImportToken !== token
            || workingCopyPath.value !== path;
    }

    function logStaleEmbeddedShapeImport(token: number, path: string | null) {
        logger.debug('pdf-shapes', 'Skipped stale embedded shape import result', () => ({
            path,
            token,
            currentToken: embeddedShapeImportToken,
            samePath: workingCopyPath.value === path,
        }));
    }

    async function applyImportedEmbeddedShapes(
        importedShapes: IShapeAnnotation[],
        path: string | null,
        token: number,
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
        if (isStaleEmbeddedShapeImport(token, path)) {
            logStaleEmbeddedShapeImport(token, path);
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
                await resetEmbeddedShapeImportBaseline(localToken, path);
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
                await resetEmbeddedShapeImportBaseline(localToken, path);
                return;
            }
            if (result.status === 'failed') {
                shapeComposable.clearPendingShapeImportAdoption();
                throw new Error('Failed to establish embedded PDF shape baseline');
            }
            if (result.status === 'stale') {
                return;
            }
            if (isStaleEmbeddedShapeImport(localToken, path)) {
                logStaleEmbeddedShapeImport(localToken, path);
                return;
            }

            const applyPlan = await applyImportedEmbeddedShapes(result.shapes, path, localToken);
            if (isStaleEmbeddedShapeImport(localToken, path)) {
                logStaleEmbeddedShapeImport(localToken, path);
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

    async function ensureManagedShapeBaselineReady() {
        if (!sourcePdfData.value && !workingCopyPath.value) {
            return;
        }
        const data = sourcePdfData.value;
        const path = workingCopyPath.value;
        const revision = documentRevisionToken.value;
        await ensureEmbeddedShapesImportedForCurrentSource();
        if (disposed) {
            return;
        }
        if (
            sourcePdfData.value !== data
            || workingCopyPath.value !== path
            || documentRevisionToken.value !== revision
        ) {
            throw new Error('PDF source changed while establishing embedded shape baseline');
        }
        if (!shapeComposable.isShapeImportBaselineReady()) {
            throw new Error('Embedded PDF shape baseline is unavailable');
        }
    }

    async function clearManagedShapesForDeferredImport() {
        embeddedShapeImportAbortController?.abort();
        embeddedShapeImportAbortController = null;
        pendingPostPaintImport = null;
        scheduledPostPaintImport = null;
        const localToken = ++embeddedShapeImportToken;
        const path = workingCopyPath.value;
        shapeComposable.resetShapeImportBaseline();
        await waitForNextTick();
        if (isStaleEmbeddedShapeImport(localToken, path)) {
            logStaleEmbeddedShapeImport(localToken, path);
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

    async function preparePersistedManagedShapesForSave(data: Uint8Array) {
        // The store captures the frontier this priming may advance past, so a
        // failed persist rolls the canonical shapes back atomically instead of
        // restoring a locally held snapshot.
        const preparation = shapeComposable.beginShapeSave();

        try {
            // The saved bytes may use compressed object streams. Always parse
            // them before adopting the persisted shape baseline; raw-name
            // absence is not evidence that the document is shape-free.
            const { importEmbeddedShapeAnnotations } = await import(
                '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations'
            );
            const importedShapes = await importEmbeddedShapeAnnotations(data);
            preparation.primePersistedShapes(importedShapes);
            await waitForNextTick();
            syncHiddenEmbeddedAnnotationDom();

            logger.debug('pdf-shapes', 'Prepared managed shapes from saved PDF bytes before persistence', () => ({
                importedShapeCount: importedShapes.length,
                currentShapeCount: shapeComposable.getAllShapes().length,
            }));

            return preparation;
        } catch (error) {
            preparation.rollback();
            logger.warn('pdf-shapes', 'Failed to prepare managed shapes from saved PDF bytes', error);
            return null;
        }
    }

    async function restorePreparedManagedShapesAfterFailedSave(preparedRollback: unknown) {
        if (!isPreparedShapeSave(preparedRollback)) {
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

    async function flushDeletedEmbeddedShapePageRefresh() {
        if (isDeletedEmbeddedShapeRefreshScheduled) {
            return;
        }

        isDeletedEmbeddedShapeRefreshScheduled = true;

        try {
            await waitForNextTick();

            while (pendingDeletedEmbeddedShapeRefreshPages.size > 0) {
                const pageNumbers = Array.from(pendingDeletedEmbeddedShapeRefreshPages)
                    .sort((left, right) => left - right);
                pendingDeletedEmbeddedShapeRefreshPages.clear();

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
            isDeletedEmbeddedShapeRefreshScheduled = false;

            if (pendingDeletedEmbeddedShapeRefreshPages.size > 0) {
                runGuardedTask(() => flushDeletedEmbeddedShapePageRefresh(), {
                    category: 'background-diagnostic',
                    scope: 'pdf-shapes',
                    message: 'Failed to refresh deleted embedded shape pages',
                });
            }
        }
    }

    function queueDeletedEmbeddedShapePageRefresh(pageNumber: number) {
        if (disposed || !Number.isFinite(pageNumber) || pageNumber < 1) {
            return;
        }

        pendingDeletedEmbeddedShapeRefreshPages.add(Math.floor(pageNumber));
        runGuardedTask(() => flushDeletedEmbeddedShapePageRefresh(), {
            category: 'background-diagnostic',
            scope: 'pdf-shapes',
            message: 'Failed to refresh deleted embedded shape pages',
        });
    }

    function refreshHiddenAnnotationPage(comment: { pageNumber?: number | null }) {
        const pageNumber = Number.isFinite(comment.pageNumber) && (comment.pageNumber ?? 0) > 0
            ? Math.floor(comment.pageNumber!)
            : currentPage.value;
        queueDeletedEmbeddedShapePageRefresh(pageNumber);
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
            rerenderEmbeddedShapePage: queueDeletedEmbeddedShapePageRefresh,
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

    watch(hiddenEmbeddedAnnotationIds, () => {
        tracePdfAnnotationSaveEvent('managed-embedded-shapes:hidden-ids-changed', () => ({
            hiddenIds: Array.from(hiddenEmbeddedAnnotationIds.value).slice(0, 30),
            hiddenIdsCount: hiddenEmbeddedAnnotationIds.value.size,
            managedIdsCount: normalizedManagedEmbeddedAnnotationIds.value.size,
        }));
        const localToken = embeddedShapeImportToken;
        const path = workingCopyPath.value;
        void waitForNextTick().then(() => {
            if (isStaleEmbeddedShapeImport(localToken, path)) {
                logStaleEmbeddedShapeImport(localToken, path);
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
        pendingPostPaintImport = null;
        scheduledPostPaintImport = null;
        embeddedShapeImportToken += 1;
        pendingDeletedEmbeddedShapeRefreshPages.clear();
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
