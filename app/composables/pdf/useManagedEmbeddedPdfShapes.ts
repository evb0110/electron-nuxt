import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    collectEmbeddedShapeAnnotationIds,
    importEmbeddedShapeAnnotations,
} from '@app/composables/pdf/pdfEmbeddedShapeAnnotations';
import {
    refreshDeletedEmbeddedShapePage,
    rerenderRenderedManagedEmbeddedShapePages,
    shouldRefreshManagedShapePage,
} from '@app/composables/pdf/pdfEmbeddedShapeRefresh';
import { resolveEmbeddedShapeImportLoadPolicy } from '@app/composables/pdf/pdfEmbeddedShapeImportPolicy';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
import type { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

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

interface IUseManagedEmbeddedPdfShapesOptions {
    viewerContainer: Ref<HTMLElement | null>;
    workingCopyPath: Ref<string | null>;
    sourcePdfData: Ref<Uint8Array | null>;
    visibleRange: Ref<IManagedEmbeddedPdfShapesPageRange>;
    bufferPages: Ref<number>;
    shapeComposable: ReturnType<typeof useAnnotationShapes>;
    suppressCommentAnnotationId: (annotationId: string) => void;
    logger: IManagedEmbeddedPdfShapesLogger;
    runGuardedTask: (
        task: () => Promise<unknown>,
        options: {
            scope: string;
            message: string;
        },
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

export function useManagedEmbeddedPdfShapes({
    viewerContainer,
    workingCopyPath,
    sourcePdfData,
    visibleRange,
    bufferPages,
    shapeComposable,
    suppressCommentAnnotationId,
    logger,
    runGuardedTask,
    nextTick: waitForNextTick,
    isPageRendered,
    invalidatePages,
    renderVisiblePages,
    hideManagedAnnotationEditors,
    currentPage,
}: IUseManagedEmbeddedPdfShapesOptions) {
    let embeddedShapeImportToken = 0;
    let pendingEmbeddedShapeImportData: Uint8Array | null = null;
    let pendingEmbeddedShapeImportPath: string | null = null;
    let embeddedShapeImportPromise: Promise<void> = Promise.resolve();
    let lastEmbeddedShapeImportPath: string | null = null;
    let hasEmbeddedShapeImportBaseline = false;
    let shouldReplaceManagedShapesOnNextImport = false;
    const pendingDeletedEmbeddedShapeRefreshPages = new Set<number>();
    let isDeletedEmbeddedShapeRefreshScheduled = false;

    function adoptPersistedManagedShapesOnNextImport() {
        shouldReplaceManagedShapesOnNextImport = true;
    }

    function clearPendingManagedShapeImportAdoption() {
        shouldReplaceManagedShapesOnNextImport = false;
    }

    const managedEmbeddedAnnotationIds = computed(() =>
        collectEmbeddedShapeAnnotationIds(shapeComposable.getAllShapes()),
    );
    const visuallySuppressedAnnotationIds = ref<Set<string>>(new Set());

    const hiddenEmbeddedAnnotationIds = computed(() => {
        const ids = new Set(managedEmbeddedAnnotationIds.value);
        shapeComposable.deletedEmbeddedAnnotationIds.value.forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                ids.add(normalizedId);
            }
        });
        visuallySuppressedAnnotationIds.value.forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                ids.add(normalizedId);
            }
        });
        return ids;
    });

    function suppressAnnotationId(annotationId: string) {
        suppressCommentAnnotationId(annotationId);
        const normalizedId = normalizePdfJsAnnotationId(annotationId);
        if (!normalizedId || visuallySuppressedAnnotationIds.value.has(normalizedId)) {
            return;
        }

        visuallySuppressedAnnotationIds.value = new Set([
            ...visuallySuppressedAnnotationIds.value,
            normalizedId,
        ]);
    }

    function unsuppressAnnotationId(annotationId: string) {
        const normalizedId = normalizePdfJsAnnotationId(annotationId);
        if (!normalizedId || !visuallySuppressedAnnotationIds.value.has(normalizedId)) {
            return;
        }
        const nextIds = new Set(visuallySuppressedAnnotationIds.value);
        nextIds.delete(normalizedId);
        visuallySuppressedAnnotationIds.value = nextIds;
    }

    function clearVisuallySuppressedAnnotationIds() {
        if (visuallySuppressedAnnotationIds.value.size === 0) {
            return;
        }
        visuallySuppressedAnnotationIds.value = new Set();
    }

    function syncHiddenEmbeddedAnnotationDom() {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }

        const hiddenIds = hiddenEmbeddedAnnotationIds.value;
        container.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
            const annotationId = normalizePdfJsAnnotationId(element.dataset.annotationId);
            if (!annotationId || !hiddenIds.has(annotationId)) {
                return;
            }

            element.remove();
        });
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
        lastEmbeddedShapeImportPath = null;
        hasEmbeddedShapeImportBaseline = false;
        shapeComposable.replaceShapes([]);
        await waitForNextTick();
        if (token !== undefined && isStaleEmbeddedShapeImport(token, path ?? null)) {
            logStaleEmbeddedShapeImport(token, path ?? null);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();
    }

    async function resolveEmbeddedShapeImportBytes(
        data: Uint8Array | null,
        path: string | null,
        token: number,
    ) {
        if (data && data.length > 0) {
            return data;
        }
        const bytes = path
            ? readDocumentBytes(path)
            : null;
        const resolvedBytes = bytes ? await bytes : null;
        if (isStaleEmbeddedShapeImport(token, path)) {
            logStaleEmbeddedShapeImport(token, path);
            return null;
        }
        return resolvedBytes;
    }

    async function importEmbeddedShapesFromResolvedSource(
        data: Uint8Array | null,
        path: string | null,
        token: number,
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
            const sourceData = await resolveEmbeddedShapeImportBytes(data, path, token);
            if (isStaleEmbeddedShapeImport(token, path)) {
                logStaleEmbeddedShapeImport(token, path);
                return { status: 'stale' };
            }
            if (!sourceData || sourceData.length === 0) {
                return { status: 'empty' };
            }
            if (isStaleEmbeddedShapeImport(token, path)) {
                logStaleEmbeddedShapeImport(token, path);
                return { status: 'stale' };
            }
            const shapes = await importEmbeddedShapeAnnotations(sourceData);
            if (isStaleEmbeddedShapeImport(token, path)) {
                logStaleEmbeddedShapeImport(token, path);
                return { status: 'stale' };
            }
            return {
                status: 'imported',
                shapes,
            };
        } catch (error) {
            logger.warn('pdf-shapes', 'Failed to import embedded PDF shapes', error);
            return { status: 'failed' };
        }
    }

    function isStaleEmbeddedShapeImport(token: number, path: string | null) {
        return embeddedShapeImportToken !== token || workingCopyPath.value !== path;
    }

    function logStaleEmbeddedShapeImport(token: number, path: string | null) {
        logger.debug('pdf-shapes', 'Skipped stale embedded shape import result', () => ({
            path,
            token,
            currentToken: embeddedShapeImportToken,
            samePath: workingCopyPath.value === path,
        }));
    }

    function shouldReconcileEmbeddedShapeImport(path: string | null) {
        return (
            !shouldReplaceManagedShapesOnNextImport
            && hasEmbeddedShapeImportBaseline
            && path === lastEmbeddedShapeImportPath
            && shapeComposable.hasShapes.value
        );
    }

    async function applyImportedEmbeddedShapes(importedShapes: IShapeAnnotation[], path: string | null, token: number) {
        const shouldReconcileWithExistingShapes = shouldReconcileEmbeddedShapeImport(path);

        logger.debug('pdf-shapes', 'Embedded shape import finished', () => ({
            path,
            token,
            importedShapeCount: importedShapes.length,
            importMode: shouldReconcileWithExistingShapes ? 'reconcile' : 'replace',
            shouldReconcileWithExistingShapes,
            currentShapeCountBeforeApply: shapeComposable.getAllShapes().length,
        }));

        if (shouldReconcileWithExistingShapes) {
            shapeComposable.reconcilePersistedShapes(importedShapes);
        } else {
            shapeComposable.replaceShapes(importedShapes);
        }

        shouldReplaceManagedShapesOnNextImport = false;
        hasEmbeddedShapeImportBaseline = true;
        lastEmbeddedShapeImportPath = path ?? null;

        await waitForNextTick();
        if (isStaleEmbeddedShapeImport(token, path)) {
            logStaleEmbeddedShapeImport(token, path);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();
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
    ) {
        pendingEmbeddedShapeImportData = data;
        pendingEmbeddedShapeImportPath = path;
        const localToken = ++embeddedShapeImportToken;

        embeddedShapeImportPromise = (async () => {
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
                lastEmbeddedShapeImportPath,
                hasEmbeddedShapeImportBaseline,
                currentShapeCount: shapeComposable.getAllShapes().length,
            }));
            if ((!data || data.length === 0) && !path) {
                await resetEmbeddedShapeImportBaseline(localToken, path);
                return;
            }

            const result = await importEmbeddedShapesFromResolvedSource(data, path, localToken);
            if (result.status === 'empty') {
                await resetEmbeddedShapeImportBaseline(localToken, path);
                return;
            }
            if (result.status === 'failed') {
                return;
            }
            if (result.status === 'stale') {
                return;
            }
            if (isStaleEmbeddedShapeImport(localToken, path)) {
                logStaleEmbeddedShapeImport(localToken, path);
                return;
            }

            await applyImportedEmbeddedShapes(result.shapes, path, localToken);
            if (isStaleEmbeddedShapeImport(localToken, path)) {
                logStaleEmbeddedShapeImport(localToken, path);
                return;
            }
            await rerenderManagedEmbeddedShapesIfNeeded();
            logPdfRenderTrace('managed-shapes-import-end', {
                path,
                token: localToken,
                currentPage: currentPage.value,
                visibleRange: visibleRange.value,
                shapeCount: shapeComposable.getAllShapes().length,
            });
        })();

        return embeddedShapeImportPromise;
    }

    function ensureEmbeddedShapesImportedForCurrentSource() {
        const data = sourcePdfData.value;
        const path = workingCopyPath.value;
        if (pendingEmbeddedShapeImportData !== data || pendingEmbeddedShapeImportPath !== path) {
            return importEmbeddedShapesForSource(data, path);
        }
        return embeddedShapeImportPromise;
    }

    async function clearManagedShapesForDeferredImport() {
        const localToken = ++embeddedShapeImportToken;
        const path = workingCopyPath.value;
        shouldReplaceManagedShapesOnNextImport = false;
        lastEmbeddedShapeImportPath = null;
        hasEmbeddedShapeImportBaseline = false;
        shapeComposable.replaceShapes([]);
        await waitForNextTick();
        if (isStaleEmbeddedShapeImport(localToken, path)) {
            logStaleEmbeddedShapeImport(localToken, path);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();
    }

    async function preparePersistedManagedShapesForSave(data: Uint8Array) {
        const snapshot = shapeComposable.captureShapeStateSnapshot();

        try {
            const importedShapes = await importEmbeddedShapeAnnotations(data);
            shapeComposable.primePersistedShapes(importedShapes);
            await waitForNextTick();
            syncHiddenEmbeddedAnnotationDom();

            logger.debug('pdf-shapes', 'Prepared managed shapes from saved PDF bytes before persistence', () => ({
                importedShapeCount: importedShapes.length,
                currentShapeCount: shapeComposable.getAllShapes().length,
            }));

            return snapshot;
        } catch (error) {
            logger.warn('pdf-shapes', 'Failed to prepare managed shapes from saved PDF bytes', error);
            return null;
        }
    }

    async function restorePreparedManagedShapesAfterFailedSave(snapshot: unknown) {
        if (!snapshot || typeof snapshot !== 'object') {
            return;
        }

        shapeComposable.restoreShapeStateSnapshot(snapshot as ReturnType<typeof shapeComposable.captureShapeStateSnapshot>);
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
                    scope: 'pdf-shapes',
                    message: 'Failed to refresh deleted embedded shape pages',
                });
            }
        }
    }

    function queueDeletedEmbeddedShapePageRefresh(pageNumber: number) {
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
            return;
        }

        pendingDeletedEmbeddedShapeRefreshPages.add(Math.floor(pageNumber));
        runGuardedTask(() => flushDeletedEmbeddedShapePageRefresh(), {
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
        const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(
            sourcePdfData.value,
            workingCopyPath.value,
        );
        if (loadPolicy.deferUntilAfterInitialRender) {
            logger.debug('pdf-shapes', 'Deferring managed shape import until after initial PDF render', {
                token,
                path: workingCopyPath.value,
            });
            runGuardedTask(() => ensureEmbeddedShapesImportedForCurrentSource(), {
                scope: 'pdf-shapes',
                message: 'Failed to import managed shapes after initial PDF render',
            });
            settleViewerLoadSettle(token);
            return;
        }

        runGuardedTask(async () => {
            try {
                await ensureEmbeddedShapesImportedForCurrentSource();
            } catch (error) {
                logger.warn('pdf-shapes', 'Managed shape import did not settle before viewer load completion', error);
            } finally {
                settleViewerLoadSettle(token);
            }
        }, {
            scope: 'pdf-shapes',
            message: 'Failed to settle managed shapes after PDF load',
        });
    }

    function importBeforeInitialRender() {
        const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(
            sourcePdfData.value,
            workingCopyPath.value,
        );
        if (!loadPolicy.awaitBeforeInitialRender) {
            return Promise.resolve();
        }

        return ensureEmbeddedShapesImportedForCurrentSource();
    }

    function syncAfterPageRendered(pageNumber: number) {
        syncHiddenEmbeddedAnnotationDom();
        hideManagedAnnotationEditors(pageNumber);
    }

    watch(hiddenEmbeddedAnnotationIds, () => {
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
        ] as const,
        async ([
            data,
            path,
        ]) => {
            const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(data, path);
            if (loadPolicy.deferUntilAfterInitialRender) {
                logger.debug('pdf-shapes', 'Queued managed shape import for deferred path-backed source', {
                    path,
                    lastImportedPath: lastEmbeddedShapeImportPath,
                    hasBaseline: hasEmbeddedShapeImportBaseline,
                });
                if (path !== lastEmbeddedShapeImportPath || !hasEmbeddedShapeImportBaseline) {
                    await clearManagedShapesForDeferredImport();
                }
                return;
            }

            await importEmbeddedShapesForSource(data, path);
        },
        { immediate: true },
    );

    return {
        managedEmbeddedAnnotationIds,
        hiddenEmbeddedAnnotationIds,
        suppressAnnotationId,
        unsuppressAnnotationId,
        clearVisuallySuppressedAnnotationIds,
        syncHiddenEmbeddedAnnotationDom,
        refreshHiddenAnnotationPage,
        refreshDeletedEmbeddedShape,
        settleViewerLoadSettledWithManagedShapes,
        importBeforeInitialRender,
        adoptPersistedManagedShapesOnNextImport,
        clearPendingManagedShapeImportAdoption,
        preparePersistedManagedShapesForSave,
        restorePreparedManagedShapesAfterFailedSave,
        syncAfterPageRendered,
    };
}
