<template>
    <div class="native-pdf-viewer relative h-full w-full">
        <div
            v-if="viewerError"
            class="absolute inset-0 flex items-center justify-center bg-muted/30"
            data-testid="native-pdf-viewer-error"
        >
            <div class="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                <UIcon
                    name="i-ph-warning-circle"
                    class="size-8 text-muted"
                />
                <p class="text-sm text-default">
                    {{ viewerError }}
                </p>
            </div>
        </div>

        <PdfInitialSurfacePlaceholder
            v-if="showInitialSurfacePlaceholder && chassisAuthority === null"
        />

        <div
            class="native-pdf-continuous-surface mx-auto min-w-full"
            :style="renderedPagesSurfaceStyle"
        >
                <section
                    v-for="pageNumber in renderedPageNumbers"
                    :key="pageNumber"
                    :ref="element => setPageElement(pageNumber, element)"
                    class="native-pdf-page-shell"
                    :style="getPageShellStyle(pageNumber)"
                    :data-page-number="pageNumber"
                >
                    <NativePdfPageContent
                        :page-number="pageNumber"
                        :page-state="pageStates[pageNumber - 1]"
                        :skeleton-content-height="pageLayouts[pageNumber - 1]?.height ?? null"
                        :show-skeleton="shouldShowPageSkeleton(pageNumber)"
                        :visual-committed="isPageVisualCommitted(pageNumber)"
                        @retry="retryPage(pageNumber)"
                        @visual-ready="handlePageVisualReady"
                        @visual-error="handlePageVisualError"
                    />
                </section>
        </div>
    </div>
</template>
<script setup lang="ts">
import {
    useDevicePixelRatio,
    useResizeObserver,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type { ComponentPublicInstance } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfNativePageSize } from '@contracts/electronApiDocuments';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import { PdfInitialSurfacePlaceholder } from '@app/modules/pdf-viewer/public/component-exports/pdfInitialSurfacePlaceholder';
import NativePdfPageContent from '@app/modules/native-pdf-viewer/components/NativePdfPageContent.vue';
import {
    createNativePdfRasterIdentity,
    type INativePdfRasterIdentity,
    nativePdfRasterIdentityCovers,
    nativePdfRasterOutputCoversRequest,
    resolveNativePdfRasterTargetWidth,
    shouldInvalidateNativePdfRaster,
    shouldPresentNativePdfPageSkeleton,
    withNativePdfRasterTargetWidth,
} from '@app/modules/native-pdf-viewer/runtime/nativePdfRasterPresentation';
import * as nativePdfViewportRestore from '@app/modules/native-pdf-viewer/runtime/canRestoreNativePdfViewportLayout';
import { resolveNativePdfRenderQueue } from '@app/modules/native-pdf-viewer/runtime/resolveNativePdfRenderQueue';
import {
    createIdleNativePdfPageState,
    preloadNativePdfPageObjectUrl,
    resolveNativePdfPageShellStyle,
} from '@app/modules/native-pdf-viewer/runtime/nativePdfPagePresentation';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/public';
import { createPagePreviewDocumentSource } from '@app/utils/document-viewer/source/createPagePreviewDocumentSource';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import type {
    IDocumentPreviewPageState,
    IPagePreviewSource,
} from '@app/utils/document-viewer/pagePreviewSource';
import { BrowserLogger } from '@app/utils/browserLogger';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
    resolveDocumentViewportPageNumbers,
} from '@app/utils/document-viewer/viewport/resolveDocumentContinuousScrollWindow';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createDocumentViewportWritePort } from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import { clampDocumentManualZoom } from '@app/utils/document-viewer/zoomPolicy';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/utils/document-viewer/layout/documentPageGutterPx';
import { useDocumentViewportLayoutLifecycle } from '@app/utils/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
import { createDocumentWheelZoomHandler } from '@app/utils/document-viewer/input/documentWheelInteraction';
import * as documentPageDisplayLayout from '@app/utils/document-viewer/layout/resolveDocumentPageDisplayLayout';
interface IProps {
    src: TDocumentRef | null;
    documentRevisionToken?: TDocumentRevisionToken | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    fitMode?: 'width' | 'height';
    viewMode?: TPdfViewMode;
    continuousScroll?: boolean;
    currentPage?: number;
    dragMode?: boolean;
    isActive?: boolean;
}
let nextNativePageSlotOwnerId = 0;
const {
    documentRevisionToken = null,
    dragMode: dragModeProp,
    fitMode = undefined,
    isActive: isActiveProp = true,
    currentPage: requestedCurrentPage = 1,
    src,
    viewMode: _viewMode = undefined,
    zoom = undefined,
    zoomMode: zoomModeProp = undefined,
} = defineProps<IProps>();
const chassisAuthority = injectDocumentViewerChassisAuthority();
const openSurfaceRenderOwner = chassisAuthority?.openSurface.claimRenderOwner();
const renderSession = chassisAuthority?.renderCoordinator.createSession(
    `native-pdf-feature:${String(++nextNativePageSlotOwnerId)}`,
);
const pageSlots = renderSession?.pageSlots;
const viewportWritePort = chassisAuthority?.viewportWritePort ?? createDocumentViewportWritePort();
const emit = defineEmits<{
    'update:effectiveZoom': [value: number];
    'update:zoom': [value: number];
    'update:zoomMode': [value: 'custom' | 'fit-width' | 'fit-height'];
    'update:currentPage': [value: number];
    'update:totalPages': [value: number];
    'update:document': [value: null];
    loading: [value: boolean];
    'initial-visual-pending': [];
    'initial-visual-ready': [payload: {pageNumber: number;}];
    'load-error': [error: unknown];
}>();
interface IPageLayout {
    top: number;
    width: number;
    height: number;
}
const NATIVE_PDF_RENDER_OVERSCAN_VIEWPORTS = 2;
const NATIVE_PDF_RENDER_MARGIN_PAGES = 3;
const NATIVE_PDF_RENDER_CONCURRENCY = 2;
const NATIVE_PDF_DEVICE_PIXEL_RATIO_CAP = 2;
const EMPTY_NATIVE_PDF_ERROR = 'PDF contains no pages';
const viewerContainer = ref<HTMLElement | null>(null);
function setPageElement(pageNumber: number, element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement) {
        pageSlots?.markMounted(pageNumber);
    } else {
        pageSlots?.markUnmounted(pageNumber);
    }
}
const pageSizes = ref<IPdfNativePageSize[]>([]);
const pageStates = ref<IDocumentPreviewPageState[]>([]);
const {pixelRatio: devicePixelRatio} = useDevicePixelRatio();
const activePage = ref(1);
const containerWidth = ref(0);
const containerHeight = ref(0);
const scrollTop = ref(0);
const viewerError = ref<string | null>(null);
const isLoading = ref(Boolean(src));
const isActive = computed(() => isActiveProp);
let releaseViewportFeature: (() => void) | null = null;
onMounted(() => {
    viewerContainer.value = chassisAuthority?.viewportElement.value ?? null;
    releaseViewportFeature = chassisAuthority?.bindViewportFeature({
        getClass: () => [
            'native-pdf-viewer-container h-full w-full app-scrollbar',
            {
                'cursor-grab': dragMode.value,
                'cursor-default': !dragMode.value,
                'native-pdf-viewer-container--initial-visual-pending': showInitialSurfacePlaceholder.value,
            },
        ],
        getStyle: () => ({}),
        events: {scroll: () => handleViewerScroll()},
        wheel: handleWheel,
    }) ?? null;
});
const showInitialSurfacePlaceholder = computed(() => isActive.value && isLoading.value && !viewerError.value);
const dragMode = computed(() => dragModeProp ?? false);
const totalPages = computed(() => pageSizes.value.length);
let activeSource: IPagePreviewSource | null = null;
let boundPageSource: IDocumentPageSource | null = null;
let loadGeneration = 0;
let nextViewportRenderRequestId = 0;
let pendingInitialVisualGeneration: number | null = null;
let readyInitialVisualGeneration: number | null = null;
let initialVisualSettlePromise: Promise<void> | null = null;
let resolveInitialVisualSettlePromise: (() => void) | null = null;
const activeRenderPageNumbers = new Set<number>();
const retainedPageNumbers = new Set<number>();
const paintedPageObjectUrls = reactive(new Map<number, string>());
const invalidatedPageVisuals = reactive(new Set<number>());
const pageInvalidationCleanup = new Map<number, () => void>();
const pageVisualErrorAttempts = new Map<number, number>();
const requestedRasterIdentities = new Map<number, INativePdfRasterIdentity>();
const committedRasterIdentities = new Map<number, INativePdfRasterIdentity>();
const pageRasterWidthCeilings = new Map<number, number>();
const pageRenderGenerations = new Map<number, number>();
const NATIVE_PDF_VISUAL_ERROR_MAX_RETRIES = 2;
const nativePdfOutputScale = computed(() => Number.isFinite(devicePixelRatio.value)
    ? Math.min(Math.max(devicePixelRatio.value, 1), NATIVE_PDF_DEVICE_PIXEL_RATIO_CAP)
    : 1);
const manualZoom = computed(() => clampDocumentManualZoom(zoom ?? 1));
const zoomMode = computed(() => zoomModeProp ?? (
    fitMode === 'height' ? 'fit-height' : 'fit-width'
));
const fitWidthAvailable = () => Math.max(1, containerWidth.value - DOCUMENT_PAGE_GUTTER_PX * 2);
const fitHeightAvailable = () => Math.max(1, containerHeight.value - DOCUMENT_PAGE_GUTTER_PX * 2);
function resolvePageDisplayScale(pageSize: IPdfNativePageSize | null | undefined) {
    return documentPageDisplayLayout.resolveDocumentPageDisplayScale({
        availableHeight: fitHeightAvailable(),
        availableWidth: fitWidthAvailable(),
        manualZoom: manualZoom.value,
        pageSize,
        zoomMode: zoomMode.value,
    });
}
const effectiveZoom = computed(() => {
    const pageSize = pageSizes.value[activePage.value - 1] ?? pageSizes.value[0] ?? null;
    return resolvePageDisplayScale(pageSize);
});
const handleWheel = createDocumentWheelZoomHandler(effectiveZoom, zoomMode, emit);
const pageLayouts = computed<IPageLayout[]>(() => {
    const dimensions = documentPageDisplayLayout.resolveDocumentPageDisplayLayouts({
        availableHeight: fitHeightAvailable(),
        availableWidth: fitWidthAvailable(),
        manualZoom: manualZoom.value,
        pageSizes: pageSizes.value,
        zoomMode: zoomMode.value,
    });
    const geometry = resolveDocumentContinuousScrollGeometry({
        pageGapPx: DOCUMENT_PAGE_GUTTER_PX,
        pageHeights: dimensions.map(page => page.height),
        totalPages: dimensions.length,
    });
    return dimensions.map((page, index) => ({
        ...page,
        top: geometry.pageTops[index] ?? DOCUMENT_PAGE_GUTTER_PX,
    }));
});
const continuousGeometry = computed(() => resolveDocumentContinuousScrollGeometry({
    pageGapPx: DOCUMENT_PAGE_GUTTER_PX,
    pageHeights: pageLayouts.value.map(page => page.height),
    totalPages: totalPages.value,
}));
const continuousSurfaceWidth = computed(() => {
    const maxPageWidth = pageLayouts.value.reduce((maxWidth, layout) => Math.max(maxWidth, layout.width), 0);
    return Math.max(containerWidth.value, maxPageWidth + DOCUMENT_PAGE_GUTTER_PX * 2, 1);
});
const continuousDocumentHeight = computed(() => {
    return Math.max(containerHeight.value, continuousGeometry.value.totalHeight, 1);
});
const renderedPageNumbers = computed(() => {
    if (totalPages.value <= 0) {
        return [] as number[];
    }

    const pages = resolveDocumentViewportPageNumbers({
        geometry: continuousGeometry.value,
        pageGapPx: DOCUMENT_PAGE_GUTTER_PX,
        scrollTop: scrollTop.value,
        totalPages: totalPages.value,
        viewportHeight: containerHeight.value,
        overscanViewports: NATIVE_PDF_RENDER_OVERSCAN_VIEWPORTS,
    });
    return pages.length ? pages : [activePage.value];
});
const renderedPagesSurfaceStyle = computed(() => ({
    height: `${continuousDocumentHeight.value}px`,
    width: `${continuousSurfaceWidth.value}px`,
}));
function emitLoading(nextLoading: boolean, options: { force?: boolean } = {}) {
    if (!options.force && isLoading.value === nextLoading) {
        return;
    }

    isLoading.value = nextLoading;
    emit('loading', nextLoading);
}
const isCurrentLoadGeneration = (generation: number) => generation === loadGeneration;
function resolveInitialVisualSettle() {
    resolveInitialVisualSettlePromise?.();
    initialVisualSettlePromise = null;
    resolveInitialVisualSettlePromise = null;
}
function ensureInitialVisualSettlePromise() {
    initialVisualSettlePromise ??= new Promise<void>((resolve) => {
        resolveInitialVisualSettlePromise = resolve;
    });

    return initialVisualSettlePromise;
}
function beginInitialVisualWait(generation: number) {
    resolveInitialVisualSettle();
    pendingInitialVisualGeneration = generation;
    readyInitialVisualGeneration = null;
    emit('initial-visual-pending');
}
function commitPageVisualToViewportSession(generation: number, pageNumber: number) {
    const openSurface = chassisAuthority?.openSurface;
    if (!openSurface) {
        return true;
    }
    const snapshot = openSurface.snapshot.value;
    const layout = pageLayouts.value[pageNumber - 1];
    const viewport = viewerContainer.value;
    const pageState = pageStates.value[pageNumber - 1];
    const viewportSession = openSurface.viewportSession.value;
    if (
        generation !== loadGeneration
        || !snapshot.identity
        || !layout
        || !viewport
        || !pageState?.objectUrl
        || paintedPageObjectUrls.get(pageNumber) !== pageState.objectUrl
        || viewportSession.requestedPage !== pageNumber
        || !viewportSession.viewportIntent
    ) {
        return false;
    }
    if (snapshot.phase === 'pending' && !openSurface.commitGeometry(snapshot.generation, {
        width: layout.width,
        height: layout.height,
        margin: DOCUMENT_PAGE_GUTTER_PX,
    })) {
        return false;
    }
    const fence = openSurfaceRenderOwner && openSurface.createOwnedRenderFence(openSurfaceRenderOwner, {
        generation: snapshot.generation,
        documentRevision: snapshot.identity.documentRevision,
        rendererVersion: generation,
        rendererRequestId: ++nextViewportRenderRequestId,
        pageNumber,
    });
    if (!fence || !openSurface.commitCanvas(fence)) {
        return false;
    }
    const viewportIntent = viewportWritePort.beginIntent(viewportSession.viewportIntent.id);
    if (!viewportWritePort.apply(viewport, {
        intent: viewportIntent,
        reason: 'native-page-visual-viewport-commit',
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
    })) {
        return false;
    }
    return openSurface.commitViewport({
        generation: snapshot.generation,
        documentRevision: snapshot.identity.documentRevision,
        viewportIntentId: viewportSession.viewportIntent.id,
        documentGeometryRevision: viewportIntent.documentRevision,
        interactionEpoch: viewportIntent.interactionEpoch,
        pageNumber,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
    }) && openSurface.markReady(fence);
}
function markInitialVisualReady(generation: number, pageNumber: number) {
    if (
        !isCurrentLoadGeneration(generation)
        || pendingInitialVisualGeneration !== generation
        || readyInitialVisualGeneration === generation
    ) {
        return false;
    }
    if (!commitPageVisualToViewportSession(generation, pageNumber)) {
        return false;
    }
    readyInitialVisualGeneration = generation;
    pendingInitialVisualGeneration = null;
    markStartupMetricOnce('evb:first-page-painted');
    emit('initial-visual-ready', { pageNumber });
    resolveInitialVisualSettle();
    return true;
}
function markInitialVisualFailed(generation: number, error: unknown) {
    if (
        !isCurrentLoadGeneration(generation)
        || pendingInitialVisualGeneration !== generation
    ) {
        return;
    }

    const normalizedError = error instanceof Error
        ? error
        : new Error('Failed to render the initial PDF preview');
    const openSurface = chassisAuthority?.openSurface;
    const openGeneration = openSurface?.snapshot.value.generation;
    if (openSurface && openGeneration !== undefined) {
        openSurface.fail(openGeneration, normalizedError.message);
    }
    pendingInitialVisualGeneration = null;
    viewerError.value = normalizedError.message;
    emit('load-error', normalizedError);
    emitLoading(false);
    resolveInitialVisualSettle();
}
function waitForViewerLoadSettled() {
    if (
        !isActive.value
        || !isLoading.value
        || viewerError.value
        || readyInitialVisualGeneration === loadGeneration
    ) {
        return Promise.resolve();
    }

    return ensureInitialVisualSettlePromise();
}
function getPageShellStyle(pageNumber: number) {
    return resolveNativePdfPageShellStyle({
        gutterPx: DOCUMENT_PAGE_GUTTER_PX,
        layout: pageLayouts.value[pageNumber - 1],
        surfaceWidth: continuousSurfaceWidth.value,
    });
}
function measureContainer() {
    const element = viewerContainer.value;
    if (!element) {
        return;
    }

    containerWidth.value = Math.max(0, element.clientWidth);
    containerHeight.value = Math.max(0, element.clientHeight);
    scrollTop.value = Math.max(0, element.scrollTop);
}
function getNeededDeviceWidth(pageNumber: number) {
    const layout = pageLayouts.value[pageNumber - 1];
    const cssWidth = Math.max(1, layout?.width ?? 1);
    return Math.max(1, Math.ceil(cssWidth * nativePdfOutputScale.value));
}
function getPageRenderTargetWidth(pageNumber: number) {
    return resolveNativePdfRasterTargetWidth(
        getNeededDeviceWidth(pageNumber),
        pageRasterWidthCeilings.get(pageNumber),
    );
}
function getPageRasterIdentity(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return null;
    }
    return createNativePdfRasterIdentity({
        generation: loadGeneration,
        pageNumber,
        pageWidth: pageSize.width,
        pageHeight: pageSize.height,
        targetWidthPx: getPageRenderTargetWidth(pageNumber),
    });
}
function shouldShowPageSkeleton(pageNumber: number) {
    const openSurface = chassisAuthority?.openSurface;
    return shouldPresentNativePdfPageSkeleton({
        openingSurfaceVisible: chassisAuthority !== null && showInitialSurfacePlaceholder.value,
        residentVisualInvalidated: invalidatedPageVisuals.has(pageNumber)
            || paintedPageObjectUrls.has(pageNumber)
                && paintedPageObjectUrls.get(pageNumber) !== pageStates.value[pageNumber - 1]?.objectUrl,
        surfaceReady: openSurface?.snapshot.value.phase === 'ready',
        visualCommitted: isPageVisualCommitted(pageNumber),
    });
}
function isPageVisualCommitted(pageNumber: number) {
    const objectUrl = pageStates.value[pageNumber - 1]?.objectUrl;
    return Boolean(
        objectUrl
        && paintedPageObjectUrls.get(pageNumber) === objectUrl
        && (!renderSession || renderSession.getPageVisual(pageNumber) === 'fresh'),
    );
}
function revokeObjectUrl(pageNumber: number, objectUrl: string) {
    if (!activeSource) {
        return;
    }

    try {
        activeSource.revokeObjectURL(objectUrl);
    } catch (error) {
        BrowserLogger.warn('native-pdf-viewer', 'Failed to revoke PDF page URL', {
            pageNumber,
            error,
        });
    }
}
function revokePageUrl(pageNumber: number) {
    const pageState = pageStates.value[pageNumber - 1];
    pageInvalidationCleanup.get(pageNumber)?.();
    pageInvalidationCleanup.delete(pageNumber);
    paintedPageObjectUrls.delete(pageNumber);
    committedRasterIdentities.delete(pageNumber);
    pageRenderGenerations.delete(pageNumber);

    if (!pageState?.objectUrl) {
        return;
    }

    revokeObjectUrl(pageNumber, pageState.objectUrl);
    pageState.objectUrl = null;
    pageState.failedRenderPx = 0;
    pageState.renderedPx = 0;
}
function resetPageState(pageNumber: number) {
    const pageState = pageStates.value[pageNumber - 1];
    if (!pageState) {
        return;
    }

    activeSource?.cancelPagePreview?.(pageNumber);
    pageState.token += 1;
    revokePageUrl(pageNumber);
    pageState.failedRenderPx = 0;
    pageState.renderedPx = 0;
    pageState.status = 'idle';
    requestedRasterIdentities.delete(pageNumber);
}
function cleanupRenderedPages() {
    for (let pageNumber = 1; pageNumber <= pageStates.value.length; pageNumber += 1) {
        revokePageUrl(pageNumber);
    }
    retainedPageNumbers.clear();
    paintedPageObjectUrls.clear();
    invalidatedPageVisuals.clear();
    pageInvalidationCleanup.clear();
    pageVisualErrorAttempts.clear();
    requestedRasterIdentities.clear();
    committedRasterIdentities.clear();
    pageRasterWidthCeilings.clear();
    pageRenderGenerations.clear();
}
function stopSource() {
    resolveInitialVisualSettle();
    cleanupRenderedPages();
    activeRenderPageNumbers.clear();
    if (chassisAuthority?.source.value === boundPageSource) {
        chassisAuthority.bindSource(null);
    }
    boundPageSource?.dispose();
    boundPageSource = null;
    activeSource?.terminate();
    activeSource = null;
}
function cleanupViewerState() {
    viewportLayoutLifecycle.cancelPendingRestore();
    stopSource();
    pageSizes.value = [];
    pageStates.value = [];
    activePage.value = Math.max(1, Math.trunc(requestedCurrentPage));
    if (viewerContainer.value) {
        const intent = viewportWritePort.beginIntent('native-viewer-cleanup');
        viewportWritePort.apply(viewerContainer.value, {
            intent,
            reason: 'native-viewer-cleanup',
            left: 0,
            top: 0,
        });
    }
    scrollTop.value = 0;
    viewerError.value = null;
    emit('update:document', null);
    emit('update:totalPages', 0);
}
function getVisiblePageNumber() {
    const container = viewerContainer.value;
    if (!container || pageLayouts.value.length === 0) {
        return activePage.value;
    }

    return resolveDocumentContinuousScrollWindow({
        currentPage: activePage.value,
        geometry: continuousGeometry.value,
        pageGapPx: DOCUMENT_PAGE_GUTTER_PX,
        pageHeights: continuousGeometry.value.pageHeights,
        renderMarginPages: 0,
        scrollTop: container.scrollTop,
        totalPages: totalPages.value,
        viewportHeight: container.clientHeight,
        overscanViewports: 0,
    })?.mostVisiblePage ?? activePage.value;
}
function syncCurrentPageFromViewport(options: {supersedeNavigation: boolean}) {
    const nextPage = getVisiblePageNumber();
    if (nextPage === activePage.value) {
        return;
    }
    const observedPage = chassisAuthority?.observePage(nextPage, options) ?? nextPage;
    activePage.value = observedPage;
    emit('update:currentPage', observedPage);
}
function getActivePageSet() {
    const activePages = new Set<number>();
    for (const pageNumber of renderedPageNumbers.value) {
        for (
            let retainedPage = pageNumber - NATIVE_PDF_RENDER_MARGIN_PAGES;
            retainedPage <= pageNumber + NATIVE_PDF_RENDER_MARGIN_PAGES;
            retainedPage += 1
        ) {
            if (retainedPage >= 1 && retainedPage <= totalPages.value) {
                activePages.add(retainedPage);
            }
        }
    }
    activePages.add(activePage.value);
    return activePages;
}
function releaseInactivePages(activePages: Set<number>) {
    for (const pageNumber of retainedPageNumbers) {
        if (activePages.has(pageNumber)) {
            continue;
        }
        const pageState = pageStates.value[pageNumber - 1];
        if (pageState && pageState.status !== 'idle') {
            resetPageState(pageNumber);
        }
        renderSession?.releasePage(pageNumber);
        invalidatedPageVisuals.delete(pageNumber);
        pageVisualErrorAttempts.delete(pageNumber);
        pageRasterWidthCeilings.delete(pageNumber);
    }
    retainedPageNumbers.clear();
    for (const pageNumber of activePages) {
        retainedPageNumbers.add(pageNumber);
    }
}

function shouldRenderPage(pageNumber: number) {
    const pageState = pageStates.value[pageNumber - 1];
    return pageState?.status === 'idle';
}

function invalidateNonCanonicalRasters(activePages: Set<number>) {
    for (const pageNumber of activePages) {
        const targetIdentity = getPageRasterIdentity(pageNumber);
        if (!targetIdentity) {
            continue;
        }
        const pageState = pageStates.value[pageNumber - 1];
        const requestIdentity = requestedRasterIdentities.get(pageNumber);
        const committedIdentity = committedRasterIdentities.get(pageNumber);
        if (pageState && shouldInvalidateNativePdfRaster({
            status: pageState.status,
            hasObjectUrl: Boolean(pageState.objectUrl),
            requestedIdentity: requestIdentity,
            committedIdentity,
            targetIdentity,
        })) {
            if (pageState.objectUrl || paintedPageObjectUrls.has(pageNumber)) {
                invalidatedPageVisuals.add(pageNumber);
            }
            resetPageState(pageNumber);
        }
    }
}
function finishInitialLoadIfSettled() {
    if (!isActive.value || !isLoading.value) {
        return;
    }

    const initialPageNumber = activePage.value;
    const initialPageState = pageStates.value[initialPageNumber - 1];
    if (
        initialPageState?.objectUrl
        && paintedPageObjectUrls.get(initialPageNumber) === initialPageState.objectUrl
    ) {
        if (markInitialVisualReady(loadGeneration, initialPageNumber)) {
            emitLoading(false);
        }
        return;
    }

    if (initialPageState?.status === 'error') {
        markInitialVisualFailed(
            loadGeneration,
            new Error('Failed to render the initially visible PDF pages'),
        );
    }
}

function failCurrentPageTransition(pageNumber: number, error: unknown) {
    const openSurface = chassisAuthority?.openSurface;
    const viewport = openSurface?.viewportSession.value;
    if (
        !openSurface
        || !viewport
        || viewport.lifecycle !== 'transitioning'
        || viewport.requestedPage !== pageNumber
    ) {
        return false;
    }
    const message = error instanceof Error
        ? error.message
        : 'Failed to render the requested PDF page';
    viewportLayoutLifecycle.cancelPendingRestore();
    return openSurface.failPageTransition(pageNumber, message);
}

async function ensurePageLoaded(pageNumber: number, generation: number) {
    const source = activeSource;
    const pageState = pageStates.value[pageNumber - 1];
    if (!source || !isActive.value || !pageState || !shouldRenderPage(pageNumber)) {
        return;
    }
    pageState.status = 'loading';
    pageState.token += 1;
    const token = pageState.token;
    const renderGeneration = renderSession?.beginPageRender(pageNumber) ?? token;
    pageRenderGenerations.set(pageNumber, renderGeneration);
    const rasterIdentity = getPageRasterIdentity(pageNumber);
    if (!rasterIdentity) {
        pageState.status = 'idle';
        return;
    }
    const targetWidthPx = rasterIdentity.targetWidthPx;
    requestedRasterIdentities.set(pageNumber, rasterIdentity);
    let pendingObjectUrl: string | null = null;
    let committedObjectUrl = false;
    let pendingInvalidationCleanup: (() => void) | null = null;

    try {
        const {
            objectUrl,
            renderedPx,
            rasterWidthCeilingPx,
            onInvalidated,
        } = await source.renderPageObjectUrl(pageNumber, { targetWidthPx });
        pendingObjectUrl = objectUrl;
        let rasterInvalidated = false;
        if (onInvalidated) {
            pendingInvalidationCleanup = onInvalidated(() => {
                rasterInvalidated = true;
                const invalidatedState = pageStates.value[pageNumber - 1];
                if (
                    source !== activeSource
                    || !invalidatedState
                    || invalidatedState.token !== token
                    || invalidatedState.objectUrl !== objectUrl
                ) {
                    return;
                }
                if (!chassisAuthority?.openSurface.invalidateResidentVisual(pageNumber)) {
                    paintedPageObjectUrls.delete(pageNumber);
                }
                invalidatedPageVisuals.add(pageNumber);
                pageInvalidationCleanup.delete(pageNumber);
                invalidatedState.objectUrl = null;
                invalidatedState.renderedPx = 0;
                invalidatedState.status = 'idle';
                invalidatedState.token += 1;
                committedRasterIdentities.delete(pageNumber);
                requestedRasterIdentities.delete(pageNumber);
                syncLoadedPages();
            });
        }
        if (!nativePdfRasterOutputCoversRequest(
            renderedPx, targetWidthPx, rasterWidthCeilingPx,
        )) {
            throw new Error('Native PDF preview rendered below its requested width');
        }
        const currentState = pageStates.value[pageNumber - 1];
        if (
            !isCurrentLoadGeneration(generation)
            || source !== activeSource
            || !currentState
            || currentState.token !== token
            || !nativePdfRasterIdentityCovers(rasterIdentity, getPageRasterIdentity(pageNumber))
        ) {
            pendingInvalidationCleanup?.();
            pendingInvalidationCleanup = null;
            source.revokeObjectURL(objectUrl);
            pendingObjectUrl = null;
            if (
                isCurrentLoadGeneration(generation)
                && source === activeSource
                && currentState?.token === token
            ) {
                resetPageState(pageNumber);
                queueMicrotask(syncLoadedPages);
            }
            return;
        }
        let canonicalRasterIdentity = rasterIdentity;
        if (rasterWidthCeilingPx !== undefined) {
            pageRasterWidthCeilings.set(pageNumber, rasterWidthCeilingPx);
            canonicalRasterIdentity = withNativePdfRasterTargetWidth(rasterIdentity, renderedPx);
            requestedRasterIdentities.set(pageNumber, canonicalRasterIdentity);
        }
        await preloadNativePdfPageObjectUrl(objectUrl);
        if (rasterInvalidated) {
            throw new Error('Native PDF preview evicted before image decode');
        }
        const decodedState = pageStates.value[pageNumber - 1];
        if (
            !isCurrentLoadGeneration(generation)
            || source !== activeSource
            || !decodedState
            || decodedState.token !== token
            || !nativePdfRasterIdentityCovers(canonicalRasterIdentity, getPageRasterIdentity(pageNumber))
        ) {
            pendingInvalidationCleanup?.();
            pendingInvalidationCleanup = null;
            source.revokeObjectURL(objectUrl);
            pendingObjectUrl = null;
            if (
                isCurrentLoadGeneration(generation)
                && source === activeSource
                && decodedState?.token === token
            ) {
                resetPageState(pageNumber);
                queueMicrotask(syncLoadedPages);
            }
            return;
        }
        const previousObjectUrl = decodedState.objectUrl;
        if (previousObjectUrl !== null) {
            paintedPageObjectUrls.delete(pageNumber);
        }
        decodedState.objectUrl = objectUrl;
        decodedState.renderedPx = renderedPx;
        decodedState.failedRenderPx = 0;
        decodedState.status = 'loaded';
        committedRasterIdentities.set(pageNumber, canonicalRasterIdentity);
        committedObjectUrl = true;
        pageInvalidationCleanup.get(pageNumber)?.();
        if (pendingInvalidationCleanup) {
            pageInvalidationCleanup.set(pageNumber, pendingInvalidationCleanup);
            pendingInvalidationCleanup = null;
        }
        if (previousObjectUrl && previousObjectUrl !== objectUrl) {
            revokeObjectUrl(pageNumber, previousObjectUrl);
        }
        finishInitialLoadIfSettled();
    } catch (error) {
        pendingInvalidationCleanup?.();
        if (pendingObjectUrl && !committedObjectUrl) {
            source.revokeObjectURL(pendingObjectUrl);
        }
        const currentState = pageStates.value[pageNumber - 1];
        if (
            !isCurrentLoadGeneration(generation)
            || source !== activeSource
            || !currentState
            || currentState.token !== token
        ) {
            return;
        }
        const attempt = pageVisualErrorAttempts.get(pageNumber) ?? 0;
        if (attempt < NATIVE_PDF_VISUAL_ERROR_MAX_RETRIES) {
            pageVisualErrorAttempts.set(pageNumber, attempt + 1);
            resetPageState(pageNumber);
            BrowserLogger.warn('native-pdf-viewer', 'Retrying PDF page preview after load failure', {
                pageNumber,
                attempt: attempt + 1,
                error,
            });
            queueMicrotask(syncLoadedPages);
            return;
        }
        currentState.status = 'error';
        failCurrentPageTransition(pageNumber, error);
        BrowserLogger.warn('native-pdf-viewer', 'Failed to load PDF page preview', {
            pageNumber,
            error,
        });
        finishInitialLoadIfSettled();
    }
}

function syncLoadedPages() {
    if (!isActive.value || !activeSource || totalPages.value <= 0) {
        return;
    }

    const activePages = getActivePageSet();
    invalidateNonCanonicalRasters(activePages);
    releaseInactivePages(activePages);
    const deferAdjacentPages = pendingInitialVisualGeneration === loadGeneration
        && !isPageVisualCommitted(activePage.value);
    const renderQueue = resolveNativePdfRenderQueue({
        activePage: activePage.value,
        activePages,
        deferAdjacentPages,
    });
    for (const pageNumber of renderQueue) {
        if (activeRenderPageNumbers.size >= NATIVE_PDF_RENDER_CONCURRENCY) {
            break;
        }
        if (!shouldRenderPage(pageNumber) || activeRenderPageNumbers.has(pageNumber)) {
            continue;
        }
        activeRenderPageNumbers.add(pageNumber);
        void ensurePageLoaded(pageNumber, loadGeneration)
            .finally(() => {
                activeRenderPageNumbers.delete(pageNumber);
                syncLoadedPages();
            });
    }
    finishInitialLoadIfSettled();
}

async function loadSource(nextSrc: TDocumentRef, generation: number) {
    const source = createNativePdfPreviewSourceFromPath(nextSrc, getDocumentFilesCapability());
    if (!isCurrentLoadGeneration(generation)) {
        source.terminate();
        return;
    }

    activeSource = source;
    const sizes = await source.getPageSizes();
    if (!isCurrentLoadGeneration(generation) || source !== activeSource) {
        source.terminate();
        return;
    }

    pageSizes.value = sizes;
    pageStates.value = sizes.map(createIdleNativePdfPageState);
    if (sizes.length > 0) {
        const initialPageNumber = clamp(
            chassisAuthority?.currentPage.value ?? requestedCurrentPage,
            1,
            sizes.length,
        );
        activePage.value = initialPageNumber;
    }
    boundPageSource = createPagePreviewDocumentSource({
        documentRef: nextSrc,
        previewSource: source,
        pageSizes: sizes,
    });
    chassisAuthority?.bindSource(boundPageSource);
}

function clearFailedLoadSource(generation: number) {
    if (!isCurrentLoadGeneration(generation)) {
        return;
    }
    stopSource();
    pageSizes.value = [];
    pageStates.value = [];
    emit('update:totalPages', 0);
}

function handleViewerScroll() {
    const container = viewerContainer.value;
    if (!container) {
        return;
    }
    if (viewportWritePort.consumeAuthorityScroll(container)) {
        scrollTop.value = Math.max(0, container.scrollTop);
        syncCurrentPageFromViewport({supersedeNavigation: false});
        syncLoadedPages();
        return;
    }
    viewportLayoutLifecycle.cancelPendingRestore();
    viewportWritePort.observeUserScroll(container);
    scrollTop.value = Math.max(0, container.scrollTop);
    syncCurrentPageFromViewport({supersedeNavigation: true});
    syncLoadedPages();
}

function handleContainerResize() {
    if (!isActive.value) {
        return;
    }
    measureContainer();
    invalidateNonCanonicalRasters(getActivePageSet());
    syncLoadedPages();
}

function retryPage(pageNumber: number) {
    pageVisualErrorAttempts.delete(pageNumber);
    resetPageState(pageNumber);
    syncLoadedPages();
}

function handlePageVisualReady(payload: {
    pageNumber: number;
    objectUrl: string;
}) {
    const pageState = pageStates.value[payload.pageNumber - 1];
    if (!pageState || pageState.objectUrl !== payload.objectUrl) {
        return;
    }
    const renderGeneration = pageRenderGenerations.get(payload.pageNumber);
    if (
        renderSession
        && (renderGeneration === undefined
            || !renderSession.commitPageRender(payload.pageNumber, renderGeneration))
    ) {
        return;
    }

    paintedPageObjectUrls.set(payload.pageNumber, payload.objectUrl);
    invalidatedPageVisuals.delete(payload.pageNumber);
    pageVisualErrorAttempts.delete(payload.pageNumber);
    const isPendingInitialVisual = isLoading.value
        && pendingInitialVisualGeneration === loadGeneration
        && payload.pageNumber === activePage.value;
    if (!isPendingInitialVisual) {
        commitPageVisualToViewportSession(loadGeneration, payload.pageNumber);
    }
    finishInitialLoadIfSettled();
    syncLoadedPages();
}

function handlePageVisualError(payload: {
    pageNumber: number;
    objectUrl: string;
}) {
    const pageState = pageStates.value[payload.pageNumber - 1];
    if (!pageState || pageState.objectUrl !== payload.objectUrl) {
        return;
    }
    const attempt = pageVisualErrorAttempts.get(payload.pageNumber) ?? 0;
    if (attempt >= NATIVE_PDF_VISUAL_ERROR_MAX_RETRIES) {
        revokePageUrl(payload.pageNumber);
        pageState.status = 'error';
        failCurrentPageTransition(
            payload.pageNumber,
            new Error('Failed to display the requested PDF page'),
        );
        finishInitialLoadIfSettled();
        return;
    }
    pageVisualErrorAttempts.set(payload.pageNumber, attempt + 1);
    resetPageState(payload.pageNumber);
    syncLoadedPages();
}

async function projectViewportSessionNavigation(options: {commitVisual?: boolean} = {}) {
    const session = chassisAuthority?.openSurface.viewportSession.value;
    const intent = session?.viewportIntent;
    if (!session?.identity || !intent || pageLayouts.value.length === 0) {
        return;
    }
    viewportLayoutLifecycle.cancelPendingRestore();
    const normalizedPage = clamp(session.requestedPage, 1, totalPages.value || 1);
    const expectedIntentId = intent.id;
    if (activePage.value !== normalizedPage) {
        activePage.value = normalizedPage;
        emit('update:currentPage', normalizedPage);
    }
    await nextTick();
    const currentSession = chassisAuthority?.openSurface.viewportSession.value;
    const container = viewerContainer.value;
    const layout = pageLayouts.value[normalizedPage - 1];
    if (
        currentSession?.viewportIntent?.id !== expectedIntentId
        || currentSession.requestedPage !== normalizedPage
        || !container
        || !layout
    ) {
        return;
    }
    const visiblePage = getVisiblePageNumber();
    const physicalIntent = viewportWritePort.beginIntent(expectedIntentId);
    viewportWritePort.apply(container, {
        intent: physicalIntent,
        reason: 'source-neutral-page-navigation',
        top: visiblePage === normalizedPage
            ? container.scrollTop
            : Math.max(0, layout.top - DOCUMENT_PAGE_GUTTER_PX),
    });
    scrollTop.value = Math.max(0, container.scrollTop);
    syncLoadedPages();
    await nextTick();
    if (options.commitVisual !== false) {
        commitPageVisualToViewportSession(loadGeneration, normalizedPage);
    }
}

function scrollToPage(pageNumber: number) {
    const normalizedPage = clamp(pageNumber, 1, totalPages.value || 1);
    if (chassisAuthority) {
        chassisAuthority.navigate(normalizedPage);
        void projectViewportSessionNavigation();
        return;
    }
    activePage.value = normalizedPage;
    emit('update:currentPage', normalizedPage);
}

watch(
    () => chassisAuthority?.openSurface.viewportSession.value.viewportIntent?.id ?? null,
    () => void projectViewportSessionNavigation(),
    {flush: 'post'},
);

watch(effectiveZoom, (value) => {
    emit('update:effectiveZoom', value);
}, { immediate: true });
const viewportLayoutLifecycle = useDocumentViewportLayoutLifecycle({
    viewerContainer,
    pageLayouts,
    captureRestoreEpoch: () => nativePdfViewportRestore.createNativePdfRestoreEpoch(loadGeneration, viewportWritePort.getInteractionEpoch()),
    canRestore: epoch => nativePdfViewportRestore.canRestoreNativePdfViewportLayout(epoch, {
        currentInteractionEpoch: viewportWritePort.getInteractionEpoch(),
        currentLoadGeneration: loadGeneration,
        hasDocumentIdentity: chassisAuthority?.openSurface.viewportSession.value.identity !== null,
        initialVisualReady: readyInitialVisualGeneration === loadGeneration,
        viewportReady: chassisAuthority === null
            || chassisAuthority.openSurface.viewportSession.value.lifecycle === 'ready',
    }),
    applyRestoredScroll: restored => {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }
        viewportWritePort.apply(container, {
            intent: viewportWritePort.beginIntent(`native-preview-zoom-anchor:${String(loadGeneration)}`),
            reason: 'zoom-anchor-restoration',
            ...restored,
        });
        scrollTop.value = Math.max(0, container.scrollTop);
    },
});
watch(pageLayouts, () => {
    if (activeSource && pageStates.value.length > 0) {
        invalidateNonCanonicalRasters(getActivePageSet());
        if (chassisAuthority?.openSurface.viewportSession.value.lifecycle === 'transitioning') {
            void projectViewportSessionNavigation({commitVisual: false});
        }
    }
}, {flush: 'sync'});
watch(nativePdfOutputScale, () => {
    invalidateNonCanonicalRasters(getActivePageSet());
    syncLoadedPages();
});

watch(
    [
        () => src,
        () => documentRevisionToken,
    ],
    async ([nextSrc]) => {
        loadGeneration += 1;
        const generation = loadGeneration;
        cleanupViewerState();

        if (!nextSrc || typeof window === 'undefined' || !isActive.value) {
            emitLoading(false, { force: true });
            return;
        }

        beginInitialVisualWait(generation);
        emitLoading(true, { force: true });
        try {
            await loadSource(nextSrc, generation);
            if (!isCurrentLoadGeneration(generation) || !activeSource) {
                return;
            }
            const restoredPage = clamp(
                chassisAuthority?.currentPage.value ?? requestedCurrentPage,
                1,
                Math.max(1, pageSizes.value.length),
            );
            activePage.value = restoredPage;
            chassisAuthority?.navigate(restoredPage);
            viewerError.value = null;
            emit('update:document', null);
            emit('update:totalPages', pageSizes.value.length);
            emit('update:currentPage', restoredPage);
            if (pageSizes.value.length === 0) {
                throw new Error(EMPTY_NATIVE_PDF_ERROR);
            }

            await nextTick();
            measureContainer();
            if (viewerContainer.value) {
                const intentId = `native-preview-load:${String(generation)}`;
                const layout = pageLayouts.value[restoredPage - 1];
                viewportWritePort.apply(viewerContainer.value, {
                    intent: viewportWritePort.beginIntent(intentId),
                    reason: 'document-load',
                    top: Math.max(0, (layout?.top ?? DOCUMENT_PAGE_GUTTER_PX) - DOCUMENT_PAGE_GUTTER_PX),
                    left: 0,
                });
            }
            scrollTop.value = Math.max(0, viewerContainer.value?.scrollTop ?? 0);
            syncLoadedPages();
            await projectViewportSessionNavigation();
        } catch (error) {
            if (!isCurrentLoadGeneration(generation)) {
                return;
            }

            clearFailedLoadSource(generation);
            viewerError.value = error instanceof Error ? error.message : 'Failed to open PDF preview';
            BrowserLogger.error('native-pdf-viewer', 'Failed to initialize native PDF viewer', {
                src: nextSrc,
                error,
            });
            markInitialVisualFailed(generation, error);
        } finally {
            if (isCurrentLoadGeneration(generation)) {
                finishInitialLoadIfSettled();
            }
        }
    },
    { immediate: true },
);

watch(isActive, async (active) => {
    if (!active) {
        loadGeneration += 1;
        stopSource();
        return;
    }

    if (src && !activeSource && import.meta.client) {
        loadGeneration += 1;
        const generation = loadGeneration;
        beginInitialVisualWait(generation);
        emitLoading(true, { force: true });
        try {
            await loadSource(src, generation);
            if (!isCurrentLoadGeneration(generation) || !activeSource) {
                return;
            }
            emit('update:totalPages', pageSizes.value.length);
            viewerError.value = null;
            if (pageSizes.value.length === 0) {
                throw new Error(EMPTY_NATIVE_PDF_ERROR);
            }
            await nextTick();
            measureContainer();
            syncLoadedPages();
            await projectViewportSessionNavigation();
        } catch (error) {
            if (!isCurrentLoadGeneration(generation)) {
                return;
            }
            clearFailedLoadSource(generation);
            viewerError.value = error instanceof Error ? error.message : 'Failed to open PDF preview';
            BrowserLogger.error('native-pdf-viewer', 'Failed to resume native PDF viewer', {
                src,
                error,
            });
            markInitialVisualFailed(generation, error);
        }
        return;
    }

    await nextTick();
    measureContainer();
    syncLoadedPages();
});

watch([
    renderedPageNumbers,
    effectiveZoom,
    totalPages,
], async () => {
    if (!import.meta.client || !isActive.value || totalPages.value <= 0) {
        return;
    }

    await nextTick();
    syncLoadedPages();
}, { flush: 'post' });

onMounted(measureContainer);
useResizeObserver(viewerContainer, handleContainerResize);
onBeforeUnmount(() => {
    releaseViewportFeature?.();
    loadGeneration += 1;
    renderSession?.dispose();
    stopSource();
});
defineExpose<IDocumentViewerExpose & {
    captureScrollSnapshot: () => unknown;
    restoreScrollSnapshot: (snapshot: unknown, options: {fallbackPage: number}) => void;
}>({
    getViewerContainer: () => viewerContainer.value,
    getCurrentPage: () => activePage.value,
    waitForViewerLoadSettled,
    scrollToPage,
    invalidatePages: (pages: number[]) => {
        for (const pageNumber of pages) {
            if (pageNumber < 1 || pageNumber > totalPages.value) {
                continue;
            }
            resetPageState(pageNumber);
        }
        syncLoadedPages();
    },
    requestScrollToCurrentResult: () => {
        scrollToPage(activePage.value);
    },
    captureScrollSnapshot: () => ({page: activePage.value}),
    restoreScrollSnapshot: (snapshot, options) => {
        const page = typeof snapshot === 'object' && snapshot !== null && 'page' in snapshot
            ? Number(snapshot.page)
            : options.fallbackPage;
        scrollToPage(Number.isFinite(page) ? page : options.fallbackPage);
    },
});
</script>
<style src="./NativePdfViewer.css"></style>
