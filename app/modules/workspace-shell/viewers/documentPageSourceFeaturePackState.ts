import type { ComponentPublicInstance } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentViewMode } from '@contracts/shared';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import type { IDocumentSearchMatch } from '@app/utils/document-viewer/search/documentSearch';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
    IDocumentSourceCapabilities,
    IDocumentSurfaceLease,
    TDocumentRenderPriority,
} from '@app/utils/document-viewer/source/documentPageSource';
import type { IDocumentTransition } from '@app/utils/document-viewer/lifecycle/createDocumentTransitionChannel';
import type { IDocumentViewerRenderSession } from '@app/utils/document-viewer/chassis/createDocumentViewerRenderCoordinator';
import { resolveDocumentContinuousScrollWindow } from '@app/utils/document-viewer/viewport/resolveDocumentContinuousScrollWindow';
import { createProvisionalDocumentPageMetrics } from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import type { TWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';

export interface IDocumentPageSourceFence {
    readonly loadGeneration: number;
    readonly openSurfaceGeneration: number | null;
    readonly documentRevision: string | null;
    readonly src: TDocumentRef | null;
}

export interface IDocumentPageSourceTransition extends IDocumentTransition<IDocumentPageSourceFence> {
    readonly phase: 'source-loaded';
    readonly source: IDocumentPageSource;
}

export function resolveDocumentPageSourceCapabilities(
    source: IDocumentPageSource,
): IDocumentSourceCapabilities {
    return {
        annotations: false,
        directImageExport: Boolean(source.rasterProvider),
        outline: Boolean(source.outlineProvider),
        pageEdits: false,
        search: Boolean(source.searchProvider ?? source.textProvider),
        text: Boolean(source.textProvider),
    };
}

export function resolveInactiveDjvuLeasePolicy(
    tier: THostResourceTier,
    pressureLevel: TWorkspaceResourcePressureLevel,
) {
    const policy = resolveOpenPathSecondaryPerformancePolicy(resolvePerformanceProfile({ tier }));
    return policy.inactiveDjvuLeasePolicy === 'release-immediately' || ![
        'healthy',
        'guarded',
    ].includes(pressureLevel)
        ? 'release-immediately'
        : 'warm-grace';
}

export interface IDocumentPageSourceFeaturePackProps {
    src: TDocumentRef | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    fitMode?: 'width' | 'height';
    viewMode?: TDocumentViewMode;
    continuousScroll?: boolean;
    dragMode?: boolean;
    documentRevisionToken?: TDocumentRevisionToken | null;
    isActive?: boolean;
    isResizing?: boolean;
    currentPage?: number;
    searchResults?: readonly IDocumentSearchMatch[];
    currentSearchResultIndex?: number;
}

export interface IDocumentPageSourceVisualState {
    generation: number;
    error: string | null;
    ready: boolean;
    lease: IDocumentSurfaceLease | null;
    priority: TDocumentRenderPriority;
    widthPx: number;
    unsubscribeInvalidation: (() => void) | null;
}

export function resolveDocumentPageSourceMountedPages(options: {
    continuousScroll: boolean;
    currentPage: number;
    destinationPage?: number | undefined;
    maxPages: number;
    mountRadius: number;
    pageCount: number;
    pageGapPx: number;
    pageHeights: number[];
    pageTops: number[];
    renderSession?: IDocumentViewerRenderSession | undefined;
    scrollTop: number;
    totalHeight: number;
    viewportHeight: number;
}) {
    if (options.pageCount === 0) {
        return [];
    }
    const viewportPages = options.continuousScroll
        ? resolveDocumentContinuousScrollWindow({
            currentPage: options.currentPage,
            geometry: {
                pageHeights: options.pageHeights,
                pageTops: options.pageTops,
                totalHeight: options.totalHeight,
            },
            pageGapPx: options.pageGapPx,
            pageHeights: options.pageHeights,
            renderMarginPages: options.mountRadius,
            scrollTop: options.scrollTop,
            totalPages: options.pageCount,
            viewportHeight: options.viewportHeight,
            overscanViewports: 1,
        })?.pageNumbers ?? []
        : [];
    return options.renderSession?.resolveMountedPages({
        currentPage: options.currentPage,
        destinationPage: options.destinationPage,
        maxPages: options.maxPages,
        pageCount: options.pageCount,
        radius: options.continuousScroll ? options.mountRadius : 3,
        viewportPages,
    }) ?? [];
}

export async function prepareDocumentPageSourceInitialState(options: {
    source: IDocumentPageSource;
    signal: AbortSignal;
    isCurrent: () => boolean;
    getCurrentPage: () => number;
    loadInitialMetric: (
        source: IDocumentPageSource,
        pageNumber: number,
        signal: AbortSignal,
    ) => Promise<IDocumentPageMetrics>;
    loadExactMetric: (pageNumber: number, signal: AbortSignal) => Promise<IDocumentPageMetrics>;
    markExact: (pageNumber: number) => void;
    publishMetrics: (metrics: IDocumentPageMetrics[]) => void;
    publishPageCount: (pageCount: number) => void;
    waitForRestore: () => Promise<void>;
}) {
    const normalizePage = () => Math.max(1, Math.min(
        options.source.pageCount,
        Math.trunc(options.getCurrentPage()),
    ));
    let initialPage = normalizePage();
    let initialMetric = await options.loadInitialMetric(options.source, initialPage, options.signal);
    if (!options.isCurrent()) {
        return null;
    }
    options.publishMetrics(createProvisionalDocumentPageMetrics(options.source.pageCount, initialMetric));
    options.markExact(initialPage);
    options.publishPageCount(options.source.pageCount);
    await options.waitForRestore();
    const restoredPage = normalizePage();
    if (restoredPage !== initialPage) {
        initialPage = restoredPage;
        initialMetric = await options.loadExactMetric(initialPage, options.signal);
        if (!options.isCurrent()) {
            return null;
        }
    }
    return {
        initialMetric,
        initialPage,
    };
}

export type TDocumentPageElement = Element | ComponentPublicInstance | null;
