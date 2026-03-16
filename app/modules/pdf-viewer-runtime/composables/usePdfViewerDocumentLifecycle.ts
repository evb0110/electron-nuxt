import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { runGuardedTask } from '@app/utils/async-guard';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer-runtime/reloadZoom';

interface IPageRange {
    start: number;
    end: number;
}

interface ICommentSyncLike {
    incrementSyncToken: () => void;
    scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
}

interface IAnnotationEditorLike {
    destroyAnnotationEditor: () => void;
    initAnnotationEditor: () => void;
}

interface IUsePdfViewerDocumentLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    effectiveScale: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    isLoading: Ref<boolean>;
    getRenderVersion: () => number;
    loadPdf: (
        src: TPdfSource,
        options?: { preservePageStructure?: boolean },
    ) => Promise<{version: number;} | null>;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    renderVisiblePages: (range: IPageRange) => Promise<void>;
    getVisibleRange: () => IPageRange;
    reRenderVisiblePagesAndSyncCurrentPage: () => Promise<void>;
    syncCurrentPageFromViewport: (options?: {
        source?: string;
        stabilize?: boolean 
    }) => Promise<void>;
    applySearchHighlights: () => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number, options?: { preferExactDom?: boolean }) => void;
    cleanupRenderedPages: () => void;
    resetScale: () => void;
    resetInsets: () => void;
    setupPagePlaceholders: () => void;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
    invalidateRenderedPages: (pages: number[]) => void;
    consumePendingInvalidation: () => number[] | null;
    commentSync: ICommentSyncLike;
    editor: IAnnotationEditorLike;
    emit: {
        (e: 'update:totalPages', total: number): void;
        (e: 'update:currentPage', page: number): void;
        (e: 'update:document', document: PDFDocumentProxy | null): void;
        (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
        (e: 'update:zoom', value: number): void;
    };
}

export function usePdfViewerDocumentLifecycle(options: IUsePdfViewerDocumentLifecycleOptions) {
    function hasRenderedPageCanvas() {
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector('.page_container .page_canvas canvas'),
        );
    }

    function hasRenderedTextLayerContent() {
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector(
                '.page_container .text-layer span, .page_container .textLayer span',
            ),
        );
    }

    function logAsyncStageError(stage: string, error: unknown) {
        BrowserLogger.error('pdf-viewer', `Failed to ${stage}`, error);
    }

    async function recoverInitialRenderIfNeeded() {
        if (!options.pdfDocument.value || options.isLoading.value || options.numPages.value <= 0) {
            return;
        }
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }
        await nextTick();
        await delay(40);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        try {
            await options.reRenderVisiblePagesAndSyncCurrentPage();
        } catch (error) {
            logAsyncStageError(
                're-render visible pages during initial recovery',
                error,
            );
        }

        await nextTick();
        await delay(80);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        try {
            await options.renderVisiblePages(options.getVisibleRange());
            await options.syncCurrentPageFromViewport({ source: 'recover-initial-render' });
        } catch (error) {
            logAsyncStageError('render visible pages during initial recovery', error);
        }
    }

    function scheduleRecoverInitialRender() {
        runGuardedTask(() => recoverInitialRenderIfNeeded(), {
            scope: 'pdf-viewer',
            message: 'Failed to recover initial PDF render',
        });
    }

    async function loadFromSource(isReload = false) {
        if (!options.src.value) {
            options.commentSync.incrementSyncToken();
            options.annotationCommentsCache.value = [];
            options.activeCommentStableKey.value = null;
            options.emit('annotation-comments', []);
            return;
        }

        const pageToRestore = isReload ? options.currentPage.value : 1;
        const displayZoomToRestore = isReload && options.zoomMode.value === 'custom'
            ? options.effectiveScale.value
            : null;
        const pagesToInvalidate = options.consumePendingInvalidation();
        const isSelectiveReload = isReload && pagesToInvalidate !== null;

        const savedBaseWidth = isSelectiveReload ? options.basePageWidth.value : null;
        const savedBaseHeight = isSelectiveReload ? options.basePageHeight.value : null;
        const savedVisibleRange = isSelectiveReload
            ? { ...options.visibleRange.value }
            : null;

        options.emit('update:document', null);
        if (!isReload) options.emit('update:totalPages', 0);
        options.emit('update:currentPage', pageToRestore);

        if (isSelectiveReload && pagesToInvalidate) {
            options.invalidateRenderedPages(pagesToInvalidate);
        } else {
            options.cleanupRenderedPages();
            options.resetScale();
            options.resetInsets();
            options.currentPage.value = pageToRestore;
            options.visibleRange.value = {
                start: pageToRestore,
                end: pageToRestore,
            };
        }
        options.editor.destroyAnnotationEditor();

        const loaded = await options.loadPdf(
            options.src.value,
            isSelectiveReload ? { preservePageStructure: true } : undefined,
        );
        if (!loaded) {
            return;
        }

        if (
            isSelectiveReload &&
            savedBaseWidth !== null &&
            savedBaseHeight !== null
        ) {
            options.basePageWidth.value = savedBaseWidth;
            options.basePageHeight.value = savedBaseHeight;
        }

        options.emit('update:document', options.pdfDocument.value);
        options.editor.initAnnotationEditor();

        options.currentPage.value = Math.min(pageToRestore, options.numPages.value);
        options.emit('update:totalPages', options.numPages.value);
        options.emit('update:currentPage', options.currentPage.value);

        if (!isSelectiveReload) {
            runGuardedTask(
                async () => {
                    const firstPage = await options.getPage(1);
                    await options.computeSkeletonInsets(
                        firstPage,
                        loaded.version,
                        options.getRenderVersion,
                    );
                },
                {
                    scope: 'pdf-viewer',
                    message: 'Failed to compute PDF skeleton insets',
                },
            );
        }

        await nextTick();

        if (!isSelectiveReload) {
            options.computeFitWidthScale(options.viewerContainer.value);
            if (displayZoomToRestore !== null) {
                const nextZoom = resolveCustomReloadZoomMultiplier({
                    currentZoom: options.zoom.value,
                    currentEffectiveScale: options.effectiveScale.value,
                    targetDisplayZoom: displayZoomToRestore,
                });
                if (nextZoom !== null && Math.abs(nextZoom - options.zoom.value) > 0.001) {
                    options.emit('update:zoom', nextZoom);
                    await nextTick();
                }
            }
            options.setupPagePlaceholders();
            if (isReload && options.currentPage.value > 1) {
                options.scrollToPage(options.currentPage.value);
                await nextTick();
            }
        } else if (savedVisibleRange) {
            options.visibleRange.value = savedVisibleRange;
        }

        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        try {
            await options.renderVisiblePages(options.visibleRange.value);
            await options.syncCurrentPageFromViewport({ source: 'load-from-source' });
        } catch (error) {
            logAsyncStageError('render visible pages after source load', error);
        }
        options.applySearchHighlights();
        options.commentSync.scheduleAnnotationCommentsSync(true);
        scheduleRecoverInitialRender();
    }

    function scheduleLoadFromSource(isReload = false) {
        runGuardedTask(() => loadFromSource(isReload), {
            scope: 'pdf-viewer',
            message: 'Failed to load PDF source',
        });
    }

    return {
        scheduleRecoverInitialRender,
        scheduleLoadFromSource,
    };
}
