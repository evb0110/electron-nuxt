import { vi } from 'vitest';
import { clamp } from 'es-toolkit/math';
import {
    ref,
    shallowRef,
} from 'vue';
import type { Ref } from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { usePdfSinglePageScroll } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageScroll';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import type { TPdfViewMode } from '@contracts/shared';
import { cast } from '@tests/helpers/cast';

type TRenderVisiblePages = Parameters<typeof usePdfSinglePageScroll>[0]['renderVisiblePages'];
type TVisibleRangeRef = Ref<{
    start: number;
    end: number;
}>;

interface ITestPageGeometry {
    offsetLeft?: number;
    offsetTop: number;
    offsetWidth?: number;
    offsetHeight: number;
}

interface IScrollHarnessOptions {
    viewMode?: TPdfViewMode;
    pageGeometries?: ITestPageGeometry[];
    mountedPageNumbers?: number[];
    canvasReadyPageNumbers?: number[];
    freshRenderedPageNumbers?: number[];
    hiddenSkeletonPageNumbers?: number[];
    skeletonPageNumbers?: number[];
    visuallyReadyPageNumbers?: number[];
    getMostVisiblePage?: (viewer: HTMLElement | null) => number;
    clientHeight?: number;
    scrollHeight?: number;
    continuousScroll?: boolean;
    renderVisiblePages?: TRenderVisiblePages;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    clientWidth?: number;
    scrollWidth?: number;
    updateVisibleRange?: (
        container: HTMLElement | null,
        numPages: number,
        visibleRange: TVisibleRangeRef,
    ) => void;
    updateCurrentPage?: Parameters<typeof usePdfSinglePageScroll>[0]['updateCurrentPage'];
}

export function createWheelEvent(
    deltaY: number,
    timeStamp: number,
    deltaX = 0,
    deltaMode = 0,
    modifiers?: {
        ctrlKey?: boolean;
        metaKey?: boolean;
    },
): WheelEvent {
    return cast<WheelEvent>({
        deltaX,
        deltaY,
        deltaMode,
        timeStamp,
        ctrlKey: modifiers?.ctrlKey ?? false,
        metaKey: modifiers?.metaKey ?? false,
        preventDefault: vi.fn(),
    });
}

export function createSinglePageScrollHarness(options?: IScrollHarnessOptions) {
    const pageGeometries: ITestPageGeometry[] = options?.pageGeometries ?? [
        {
            offsetTop: 20,
            offsetHeight: 100,
        },
        {
            offsetTop: 140,
            offsetHeight: 180,
        },
        {
            offsetTop: 340,
            offsetHeight: 100,
        },
    ];

    const clientHeight = options?.clientHeight ?? 100;
    const clientWidth = options?.clientWidth ?? 100;
    const scrollHeight = options?.scrollHeight ?? 440;
    const scrollWidth = options?.scrollWidth ?? clientWidth;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    let scrollTop = 0;
    let scrollLeft = 0;
    const mountedPageNumbers = options?.mountedPageNumbers
        ?? pageGeometries.map((_, index) => index + 1);
    const visuallyReadyPageNumbers = new Set(
        options?.visuallyReadyPageNumbers ?? mountedPageNumbers,
    );
    const canvasReadyPageNumbers = new Set(
        options?.canvasReadyPageNumbers ?? options?.visuallyReadyPageNumbers ?? mountedPageNumbers,
    );
    const freshRenderedPageNumbers = new Set(
        options?.freshRenderedPageNumbers ?? options?.visuallyReadyPageNumbers ?? mountedPageNumbers,
    );
    const skeletonPageNumbers = new Set(options?.skeletonPageNumbers ?? []);
    const hiddenSkeletonPageNumbers = new Set(options?.hiddenSkeletonPageNumbers ?? []);
    const pageElements = pageGeometries.map((page, index) => {
        const mountedPage = mountedPageNumbers[index] ?? index + 1;
        return cast<HTMLElement>({
            offsetLeft: page.offsetLeft ?? 0,
            ...page,
            offsetWidth: page.offsetWidth ?? clientWidth,
            dataset: {page: String(mountedPage)},
            classList: { contains: vi.fn((className: string) => (
                className === 'page_container--rendered'
                && visuallyReadyPageNumbers.has(mountedPage)
            )) },
            querySelector: vi.fn((selector: string) => {
                if (selector === '.page_canvas canvas') {
                    return canvasReadyPageNumbers.has(mountedPage) ? {} : null;
                }
                if (selector === '.pdf-page-skeleton') {
                    return skeletonPageNumbers.has(mountedPage)
                        ? {style: {display: hiddenSkeletonPageNumbers.has(mountedPage) ? 'none' : ''}}
                        : null;
                }
                return null;
            }),
        });
    });
    const container = cast<HTMLElement>({
        clientHeight,
        clientWidth,
        scrollHeight,
        scrollWidth,
        querySelector: vi.fn((selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements.find((pageElement) => {
                const mountedPage = Number.parseInt(pageElement.dataset?.page ?? '', 10);
                return mountedPage === pageNumber;
            }) ?? null;
        }),
        querySelectorAll: vi.fn(() => pageElements),
    });
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = clamp(value, 0, maxScrollTop);
        },
    });
    Object.defineProperty(container, 'scrollLeft', {
        get: () => scrollLeft,
        set: (value: number) => {
            scrollLeft = clamp(value, 0, maxScrollLeft);
        },
    });

    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const scrollToPageInternal = vi.fn();
    const renderVisiblePages = vi.fn(options?.renderVisiblePages ?? (async () => {}));
    const emitCurrentPage = vi.fn((page: number) => {
        currentPage.value = page;
    });
    const emitNavigationFeedbackPage = vi.fn();

    const defaultMostVisiblePage = (viewer: HTMLElement | null) => {
        if (!viewer) {
            return 1;
        }
        if (viewer.scrollTop >= 320) {
            return 3;
        }
        if (viewer.scrollTop >= 120) {
            return 2;
        }
        return 1;
    };
    const getMostVisiblePage = options?.getMostVisiblePage ?? defaultMostVisiblePage;
    const updateVisibleRange = vi.fn((
        viewer: HTMLElement | null,
        pageCount: number,
    ) => options?.updateVisibleRange?.(viewer, pageCount, visibleRange));

    const singlePageScroll = usePdfSinglePageScroll({
        viewerContainer: shallowRef(container),
        numPages: ref(pageGeometries.length),
        currentPage,
        scaledMargin: ref(20),
        viewMode: ref(options?.viewMode ?? 'single'),
        continuousScroll: ref(options?.continuousScroll ?? false),
        isLoading: ref(false),
        pdfDocument: shallowRef({} as PDFDocumentProxy),
        getMostVisiblePage,
        scrollToPageInternal,
        updateVisibleRange,
        updateCurrentPage: vi.fn(options?.updateCurrentPage ?? ((viewer: HTMLElement | null) => getMostVisiblePage(viewer))),
        renderVisiblePages,
        ensurePageMetricsInRange: options?.ensurePageMetricsInRange,
        isPageFreshlyRenderedForNavigation: pageNumber => freshRenderedPageNumbers.has(pageNumber),
        visibleRange,
        emitCurrentPage,
        emitNavigationFeedbackPage,
    });

    return {
        container,
        currentPage,
        emitCurrentPage,
        emitNavigationFeedbackPage,
        markPageCanvasReady: (pageNumber: number) => canvasReadyPageNumbers.add(pageNumber),
        markPageFreshRendered: (pageNumber: number) => freshRenderedPageNumbers.add(pageNumber),
        markPageStaleRendered: (pageNumber: number) => freshRenderedPageNumbers.delete(pageNumber),
        hidePageSkeleton: (pageNumber: number) => skeletonPageNumbers.delete(pageNumber),
        markPageVisualReady: (pageNumber: number) => {
            visuallyReadyPageNumbers.add(pageNumber);
            freshRenderedPageNumbers.add(pageNumber);
        },
        renderVisiblePages,
        updateVisibleRange,
        visibleRange,
        scrollToPageInternal,
        singlePageScroll,
    };
}

export function createSinglePageNavigationControllerHarness() {
    const pageGeometries: ITestPageGeometry[] = [
        {
            offsetTop: 20,
            offsetHeight: 100,
        },
        {
            offsetTop: 140,
            offsetHeight: 100,
        },
        {
            offsetTop: 260,
            offsetHeight: 100,
        },
    ];
    let scrollTop = 0;
    const visuallyReadyPageNumbers = new Set([
        1,
        2,
    ]);
    const pageElements = pageGeometries.map((page, index) => {
        const pageNumber = index + 1;
        return cast<HTMLElement>({
            ...page,
            offsetLeft: 0,
            offsetWidth: 100,
            dataset: {page: String(pageNumber)},
            classList: { contains: vi.fn((className: string) => (
                className === 'page_container--rendered'
                && visuallyReadyPageNumbers.has(pageNumber)
            )) },
            querySelector: vi.fn((selector: string) => (
                selector === '.page_canvas canvas'
                && visuallyReadyPageNumbers.has(pageNumber)
                    ? {}
                    : null
            )),
        });
    });
    const container = cast<HTMLElement>({
        clientHeight: 100,
        clientWidth: 100,
        scrollHeight: 400,
        scrollWidth: 100,
        querySelector: vi.fn((selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const pageNumber = Number.parseInt(match[1], 10);
            return pageElements[pageNumber - 1] ?? null;
        }),
        querySelectorAll: vi.fn(() => pageElements),
    });
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = clamp(value, 0, 300);
        },
    });
    Object.defineProperty(container, 'scrollLeft', {
        get: () => 0,
        set: () => {},
    });

    const currentPage = ref(1);
    const requestedCurrentPage = ref<number | undefined>(undefined);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const cancelPendingSearchScroll = vi.fn();
    const emitCurrentPage = vi.fn((page: number) => {
        currentPage.value = page;
    });
    const singlePageScroll = usePdfSinglePageNavigationController({
        requestedCurrentPage,
        viewerContainer: shallowRef(container),
        numPages: ref(3),
        currentPage,
        scaledMargin: ref(20),
        viewMode: ref<TPdfViewMode>('single'),
        continuousScroll: ref(false),
        isLoading: ref(false),
        pdfDocument: shallowRef({} as PDFDocumentProxy),
        getMostVisiblePage: () => currentPage.value,
        scrollToPageInternal: vi.fn(),
        updateVisibleRange: vi.fn(),
        updateCurrentPage: vi.fn(() => currentPage.value),
        renderVisiblePages: vi.fn(async () => {}),
        visibleRange,
        emitCurrentPage,
        cancelPendingSearchScroll,
    });

    return {
        cancelPendingSearchScroll,
        container,
        currentPage,
        requestedCurrentPage,
        singlePageScroll,
        visibleRange,
    };
}
