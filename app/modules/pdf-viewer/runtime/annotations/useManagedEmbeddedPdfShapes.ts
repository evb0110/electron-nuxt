import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import { collectEmbeddedShapeAnnotationIds } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/collectEmbeddedShapeAnnotationIds';
import { refreshDeletedEmbeddedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/refreshDeletedEmbeddedShapePage';
import { shouldRefreshManagedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/shouldRefreshManagedShapePage';
import { syncHiddenEmbeddedAnnotationDom as syncHiddenEmbeddedAnnotationDomForContainer } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { IGuardAsyncOptions } from '@app/utils/asyncGuard';
import { tryOnScopeDispose } from '@vueuse/core';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    acquireEmbeddedShapeImport,
    createEmbeddedShapeImportCacheKey,
} from '@app/modules/pdf-viewer/runtime/annotations/embeddedShapeImportCache';
import type {TEmbeddedShapeImportCapabilityReason} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient';

function isEmbeddedShapeImportCapabilityError(
    error: unknown,
): error is Error & {reason: TEmbeddedShapeImportCapabilityReason} {
    if (!error || typeof error !== 'object' || !(error instanceof Error)) {
        return false;
    }
    const reason = (error as {reason?: unknown}).reason;
    return error.name === 'EmbeddedShapeImportCapabilityError'
        && (reason === 'native-index-capability-unavailable' || reason === 'native-index-failed');
}

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
    /** All canonical PDF refs, including non-shape annotations and tombstones. */
    storeOwnedAnnotationIds?: Ref<ReadonlySet<string>>;
    /** @deprecated The canonical editor layer no longer exposes PDF.js editors. */
    hideManagedAnnotationEditors?: (..._args: never[]) => void;
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
    storeOwnedAnnotationIds,
    logger,
    runGuardedTask,
    nextTick: waitForNextTick,
    isPageRendered,
    invalidatePages: _invalidatePages,
    renderVisiblePages,
    currentPage,
}: IUseManagedEmbeddedPdfShapesOptions) => {
    let embeddedShapeImportToken = 0;
    let pendingEmbeddedShapeImportData: Uint8Array | null = null;
    let pendingEmbeddedShapeImportPath: string | null = null;
    let pendingEmbeddedShapeImportRevision: TDocumentRevisionToken | null = null;
    let embeddedShapeImportPromise: Promise<void> = Promise.resolve();
    let embeddedShapeBaselineComplete = true;
    let embeddedShapeImportAbortController: AbortController | null = null;
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
        // The Vue surface is the source of truth for every canonical annotation.
        // Suppress their native PDF paint immediately, including tombstones, so
        // an annotation cannot flash while the page layer catches up.
        return new Set([
            ...hiddenEmbeddedAnnotationIds.value,
            ...(storeOwnedAnnotationIds?.value ?? []),
        ]);
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
        | {
            status: 'incomplete';
            reason: TEmbeddedShapeImportCapabilityReason
        }
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
            const importClient = await import(
                '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient'
            );
            const nativePathSource = importClient.isNativeEmbeddedShapeImportSource(path);
            const importData = nativePathSource ? null : data;
            const key = createEmbeddedShapeImportCacheKey({
                data: importData,
                path,
                documentRevisionToken: revision,
                stableSourceIdentity,
            });
            const shapes = await acquireEmbeddedShapeImport(key, async (sharedSignal) => {
                if (nativePathSource) {
                    return importClient.importEmbeddedShapeAnnotationsFromNativePath(path!, {
                        signal: sharedSignal,
                        expectedDocumentRevisionToken: revision,
                    });
                }
                return data && data.length > 0
                    ? importClient.importEmbeddedShapeAnnotationsUsingWorker(data, {signal: sharedSignal})
                    : importClient.importEmbeddedShapeAnnotationsFromPathInWorker(path!, {signal: sharedSignal});
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
            if (isEmbeddedShapeImportCapabilityError(error)) {
                return {
                    status: 'incomplete',
                    reason: error.reason,
                };
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
        if (isStaleEmbeddedShapeImport(token, path, revision)) {
            logStaleEmbeddedShapeImport(token, path, revision);
            return;
        }
        logger.debug('pdf-shapes', 'Embedded shape import finished', () => ({
            path,
            token,
            importedShapeCount: importedShapes.length,
            importMode: 'deferred-to-canonical-document-parse',
            importReason: 'canonical store no longer accepts legacy shape scans',
            skipRerender: true,
        }));

        await waitForNextTick();
        if (isStaleEmbeddedShapeImport(token, path, revision)) {
            logStaleEmbeddedShapeImport(token, path, revision);
            return;
        }
        syncHiddenEmbeddedAnnotationDom();

        return true;
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
        embeddedShapeBaselineComplete = true;

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
                embeddedShapeBaselineComplete = false;
                throw new Error('Failed to establish embedded PDF shape baseline');
            }
            if (result.status === 'unscannable') {
                // No baseline is established, so the document stays openable and
                // savable while every shape write stays additive.
                embeddedShapeBaselineComplete = false;
                return;
            }
            if (result.status === 'incomplete') {
                // A trusted desktop path without the native shape index is a
                // capability gap, not proof that the PDF has no shapes. Keep
                // the baseline incomplete and never retry through bytes.
                embeddedShapeBaselineComplete = false;
                logger.warn('pdf-shapes', 'Native embedded shape index is unavailable; leaving the shape baseline incomplete', result.reason);
                return;
            }
            if (result.status === 'stale') {
                return;
            }
            if (isStaleEmbeddedShapeImport(localToken, path, revision)) {
                logStaleEmbeddedShapeImport(localToken, path, revision);
                return;
            }

            await applyImportedEmbeddedShapes(result.shapes, path, localToken, revision);
            if (isStaleEmbeddedShapeImport(localToken, path, revision)) {
                logStaleEmbeddedShapeImport(localToken, path, revision);
                return;
            }
            embeddedShapeBaselineComplete = true;
            logPdfRenderTrace('managed-shapes-import-end', {
                path,
                token: localToken,
                currentPage: currentPage.value,
                visibleRange: visibleRange.value,
                shapeCount: shapeComposable.getAllShapes().length,
                skippedRerender: true,
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
            // The source watcher owns the next baseline; saves remain additive until it finishes.
            return false;
        }
        return embeddedShapeBaselineComplete;
    }

    async function clearManagedShapesForDeferredImport() {
        embeddedShapeImportAbortController?.abort();
        embeddedShapeImportAbortController = null;
        pendingPostPaintImport = null;
        scheduledPostPaintImport = null;
        embeddedShapeBaselineComplete = true;
        const localToken = ++embeddedShapeImportToken;
        const path = workingCopyPath.value;
        const revision = documentRevisionToken.value;
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

    function preparePersistedManagedShapesForSave(
        _data?: Uint8Array,
    ): Promise<null> {
        // Legacy shape priming was removed with the canonical store's import
        // modes. The writer's document parse owns the saved baseline now.
        return Promise.resolve(null);
    }

    function restorePreparedManagedShapesAfterFailedSave(_preparedRollback: unknown) {
        return Promise.resolve();
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
                if (pendingPostPaintImport || pendingEmbeddedShapeImportData || pendingEmbeddedShapeImportPath) {
                    await clearManagedShapesForDeferredImport();
                }
                return;
            }
            logger.debug('pdf-shapes', 'Queued managed shape import for deferred path-backed source', {path});
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
