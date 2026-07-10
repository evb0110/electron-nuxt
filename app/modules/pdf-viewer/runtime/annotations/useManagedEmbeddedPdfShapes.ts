import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import { collectEmbeddedShapeAnnotationIds } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/collectEmbeddedShapeAnnotationIds';
import { refreshDeletedEmbeddedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/refreshDeletedEmbeddedShapePage';
import { rerenderRenderedManagedEmbeddedShapePages } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/rerenderRenderedManagedEmbeddedShapePages';
import { shouldRefreshManagedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/shouldRefreshManagedShapePage';
import { syncHiddenEmbeddedAnnotationDom as syncHiddenEmbeddedAnnotationDomForContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import { resolveEmbeddedShapeImportLoadPolicy } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/resolveEmbeddedShapeImportLoadPolicy';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IGuardAsyncOptions } from '@app/utils/asyncGuard';
import { tryOnScopeDispose } from '@vueuse/core';

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

export interface IManagedEmbeddedPdfShapeStateSnapshot {
    shapes: IShapeAnnotation[];
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
    baselineSignature: string;
    selectedShapeId: string | null;
}

export interface IManagedEmbeddedPdfShapeStore {
    hasShapes: { readonly value: boolean };
    deletedEmbeddedAnnotationIds: { readonly value: Set<string> };
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys: () => string[];
    replaceShapes: (shapes: IShapeAnnotation[]) => void;
    reconcilePersistedShapes: (shapes: IShapeAnnotation[]) => void;
    primePersistedShapes: (shapes: IShapeAnnotation[]) => void;
    adoptPersistedShapeMetadata: (shapes: IShapeAnnotation[]) => void;
    captureShapeStateSnapshot: () => IManagedEmbeddedPdfShapeStateSnapshot;
    restoreShapeStateSnapshot: (snapshot: IManagedEmbeddedPdfShapeStateSnapshot) => void;
}

interface IUseManagedEmbeddedPdfShapesOptions {
    viewerContainer: Ref<HTMLElement | null>;
    workingCopyPath: Ref<string | null>;
    sourcePdfData: Ref<Uint8Array | null>;
    sourcePdfFileSize: Ref<number | null>;
    visibleRange: Ref<IManagedEmbeddedPdfShapesPageRange>;
    bufferPages: Ref<number>;
    shapeComposable: IManagedEmbeddedPdfShapeStore;
    suppressCommentAnnotationId: (annotationId: string) => void;
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
    workingCopyPath,
    sourcePdfData,
    sourcePdfFileSize,
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
}: IUseManagedEmbeddedPdfShapesOptions) => {
    let embeddedShapeImportToken = 0;
    let pendingEmbeddedShapeImportData: Uint8Array | null = null;
    let pendingEmbeddedShapeImportPath: string | null = null;
    let embeddedShapeImportPromise: Promise<void> = Promise.resolve();
    let lastEmbeddedShapeImportPath: string | null = null;
    let hasEmbeddedShapeImportBaseline = false;
    let shouldAdoptSelfSaveMetadataOnNextImport = false;
    const pendingDeletedEmbeddedShapeRefreshPages = new Set<number>();
    let isDeletedEmbeddedShapeRefreshScheduled = false;
    let isDeferredHiddenEmbeddedAnnotationDomSyncScheduled = false;
    let deferredHiddenAnnotationSyncFrame: number | null = null;
    let disposed = false;

    function adoptPersistedManagedShapesOnNextImport() {
        shouldAdoptSelfSaveMetadataOnNextImport = true;
    }

    function clearPendingManagedShapeImportAdoption() {
        shouldAdoptSelfSaveMetadataOnNextImport = false;
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
    const visuallySuppressedAnnotationIds = ref<Set<string>>(new Set());

    const forceHiddenEmbeddedAnnotationIds = computed(() => {
        const ids = new Set<string>();
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
        tracePdfAnnotationSaveEvent('managed-embedded-shapes:suppress-annotation-id', () => ({
            annotationId,
            normalizedId,
            visuallySuppressed: Array.from(visuallySuppressedAnnotationIds.value).slice(0, 20),
        }));
    }

    function unsuppressAnnotationId(annotationId: string) {
        const normalizedId = normalizePdfJsAnnotationId(annotationId);
        if (!normalizedId || !visuallySuppressedAnnotationIds.value.has(normalizedId)) {
            return;
        }
        const nextIds = new Set(visuallySuppressedAnnotationIds.value);
        nextIds.delete(normalizedId);
        visuallySuppressedAnnotationIds.value = nextIds;
        tracePdfAnnotationSaveEvent('managed-embedded-shapes:unsuppress-annotation-id', () => ({
            annotationId,
            normalizedId,
            visuallySuppressed: Array.from(visuallySuppressedAnnotationIds.value).slice(0, 20),
        }));
    }

    function clearVisuallySuppressedAnnotationIds() {
        if (visuallySuppressedAnnotationIds.value.size === 0) {
            return;
        }
        visuallySuppressedAnnotationIds.value = new Set();
        tracePdfAnnotationSaveEvent('managed-embedded-shapes:clear-visually-suppressed-ids');
    }

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
        shouldAdoptSelfSaveMetadataOnNextImport = false;
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
            const { importEmbeddedShapeAnnotations } = await import(
                '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations'
            );
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

    function hasShapeStateForSelfSaveImport() {
        return (
            shapeComposable.getAllShapes().length > 0
            || shapeComposable.getDeletedEmbeddedAnnotationIds().length > 0
            || shapeComposable.getDeletedEmbeddedShapeStableKeys().length > 0
        );
    }

    function planEmbeddedShapeImportApply(path: string | null) {
        const isSameSource = path === lastEmbeddedShapeImportPath;
        if (
            shouldAdoptSelfSaveMetadataOnNextImport
            && isSameSource
            && (hasEmbeddedShapeImportBaseline || hasShapeStateForSelfSaveImport())
        ) {
            return {
                mode: 'self-save-metadata',
                skipRerender: true,
                reason: 'preserved-live-session-save',
            };
        }

        if (hasEmbeddedShapeImportBaseline && isSameSource) {
            return {
                mode: 'reconcile',
                skipRerender: false,
                reason: shapeComposable.hasShapes.value
                    ? 'same-source-dirty-shape-reconcile'
                    : 'same-source-clean-shape-reconcile',
            };
        }

        return {
            mode: 'replace',
            skipRerender: false,
            reason: 'new-source-import',
        };
    }

    async function applyImportedEmbeddedShapes(
        importedShapes: IShapeAnnotation[],
        path: string | null,
        token: number,
    ) {
        const applyPlan = planEmbeddedShapeImportApply(path);

        logger.debug('pdf-shapes', 'Embedded shape import finished', () => ({
            path,
            token,
            importedShapeCount: importedShapes.length,
            importMode: applyPlan.mode,
            importReason: applyPlan.reason,
            skipRerender: applyPlan.skipRerender,
            shouldAdoptSelfSaveMetadataOnNextImport,
            currentShapeCountBeforeApply: shapeComposable.getAllShapes().length,
        }));

        switch (applyPlan.mode) {
            case 'self-save-metadata':
                shapeComposable.adoptPersistedShapeMetadata(importedShapes);
                break;
            case 'reconcile':
                shapeComposable.reconcilePersistedShapes(importedShapes);
                break;
            case 'replace':
                shapeComposable.replaceShapes(importedShapes);
                break;
        }

        shouldAdoptSelfSaveMetadataOnNextImport = false;
        hasEmbeddedShapeImportBaseline = true;
        lastEmbeddedShapeImportPath = path ?? null;

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
    ) {
        if (disposed) {
            return Promise.resolve();
        }
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
                shouldAdoptSelfSaveMetadataOnNextImport = false;
                return;
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
        shouldAdoptSelfSaveMetadataOnNextImport = false;
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
            const { importEmbeddedShapeAnnotations } = await import(
                '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations'
            );
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

        shapeComposable.restoreShapeStateSnapshot(snapshot as IManagedEmbeddedPdfShapeStateSnapshot);
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
        const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(
            sourcePdfData.value,
            workingCopyPath.value,
            sourcePdfFileSize.value,
        );
        if (loadPolicy.skipAutomaticImport) {
            logger.debug('pdf-shapes', 'Skipping automatic managed shape import for large path-backed source', {
                token,
                path: workingCopyPath.value,
                sourceFileSize: sourcePdfFileSize.value,
            });
            settleViewerLoadSettle(token);
            return;
        }
        if (loadPolicy.deferUntilAfterInitialRender) {
            logger.debug('pdf-shapes', 'Deferring managed shape import until after initial PDF render', {
                token,
                path: workingCopyPath.value,
            });
            runGuardedTask(() => ensureEmbeddedShapesImportedForCurrentSource(), {
                category: 'background-diagnostic',
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
            category: 'background-diagnostic',
            scope: 'pdf-shapes',
            message: 'Failed to settle managed shapes after PDF load',
        });
    }

    function importBeforeInitialRender() {
        const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(
            sourcePdfData.value,
            workingCopyPath.value,
            sourcePdfFileSize.value,
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
            sourcePdfFileSize.value,
        ] as const,
        async ([
            data,
            path,
            fileSize,
        ]) => {
            const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(data, path, fileSize);
            if (loadPolicy.skipAutomaticImport) {
                logger.debug('pdf-shapes', 'Skipped managed shape import for large path-backed source', {
                    path,
                    sourceFileSize: fileSize,
                    lastImportedPath: lastEmbeddedShapeImportPath,
                    hasBaseline: hasEmbeddedShapeImportBaseline,
                });
                if (path !== lastEmbeddedShapeImportPath || !hasEmbeddedShapeImportBaseline) {
                    await clearManagedShapesForDeferredImport();
                }
                return;
            }
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

    tryOnScopeDispose(() => {
        disposed = true;
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
};
