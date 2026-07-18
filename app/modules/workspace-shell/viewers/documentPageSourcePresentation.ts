import type {
    IDocumentPageMetrics,
    IDocumentSurfaceLease,
    TDocumentRenderPriority,
} from '@app/utils/document-viewer/source/documentPageSource';

const DOCUMENT_RENDER_PRIORITY_RANK: Record<TDocumentRenderPriority, number> = {
    navigation: 5,
    visible: 4,
    nearby: 3,
    thumbnail: 2,
    prefetch: 1,
};

interface IConnectedPageImageQuery {
    loadGeneration: number;
    openingTarget: HTMLElement | null;
    pageNumber: number;
    renderGeneration: number;
    viewerContainer: HTMLElement | null;
}

export const DOCUMENT_PAGE_SKELETON_PADDING = Object.freeze({
    bottom: 56,
    left: 56,
    right: 56,
    top: 56,
});

export type TDocumentPageSourceVisual = 'none' | 'skeleton' | 'fresh' | 'error';

export interface IDocumentPageSourceVisualPresentation {
    error: boolean;
    fresh: boolean;
    pendingFrame: boolean;
    skeleton: boolean;
}

export function resolveDocumentPageSourceVisualPresentation(
    visual: TDocumentPageSourceVisual,
): IDocumentPageSourceVisualPresentation {
    switch (visual) {
        case 'none':
            return {
                error: false,
                fresh: false,
                pendingFrame: true,
                skeleton: false,
            };
        case 'skeleton':
            return {
                error: false,
                fresh: false,
                pendingFrame: false,
                skeleton: true,
            };
        case 'fresh':
            return {
                error: false,
                fresh: true,
                pendingFrame: false,
                skeleton: false,
            };
        case 'error':
            return {
                error: true,
                fresh: false,
                pendingFrame: false,
                skeleton: false,
            };
        default: {
            const exhaustive: never = visual;
            throw new Error(`Unknown document page visual: ${String(exhaustive)}`);
        }
    }
}

interface IDocumentPageSourceVisualState {
    error: string | null;
    ready: boolean;
}

interface IDocumentPageSourceViewportVisual {
    kind: 'empty' | 'page' | 'failed';
    pageNumber?: number;
    presentation?: 'cold-shell' | 'prepared-shell' | 'skeleton' | 'canvas' | 'error';
}

export function resolveDocumentPageSourceVisual(options: {
    pageNumber: number;
    presentPendingAsSkeleton: boolean;
    state?: IDocumentPageSourceVisualState | undefined;
    viewportVisual?: IDocumentPageSourceViewportVisual | undefined;
}): TDocumentPageSourceVisual {
    const pendingVisual: TDocumentPageSourceVisual = options.presentPendingAsSkeleton
        ? 'skeleton'
        : 'none';
    const viewportVisual = options.viewportVisual;
    if (viewportVisual?.kind === 'page' && viewportVisual.pageNumber === options.pageNumber) {
        if (viewportVisual.presentation === 'skeleton') {
            return 'skeleton';
        }
        if (viewportVisual.presentation === 'error') {
            return 'error';
        }
        if (viewportVisual.presentation === 'canvas') {
            return options.state?.ready ? 'fresh' : pendingVisual;
        }
        return pendingVisual;
    }
    if (options.state?.error) {
        return 'error';
    }
    return options.state?.ready ? 'fresh' : pendingVisual;
}

export function hasHigherDocumentRenderPriority(
    next: TDocumentRenderPriority,
    previous: TDocumentRenderPriority,
) {
    return DOCUMENT_RENDER_PRIORITY_RANK[next] > DOCUMENT_RENDER_PRIORITY_RANK[previous];
}

export function resolveDocumentPageSourceRenderWidthPx(
    metrics: IDocumentPageMetrics,
    effectiveZoom: number,
    pixelRatio: number,
) {
    return Math.max(1, Math.round(metrics.widthPoints * effectiveZoom * pixelRatio));
}

export function isDocumentPageSourceRasterCurrentForLayout(
    state: {widthPx: number},
    metrics: IDocumentPageMetrics,
    effectiveZoom: number,
    pixelRatio: number,
) {
    return state.widthPx === resolveDocumentPageSourceRenderWidthPx(
        metrics,
        effectiveZoom,
        pixelRatio,
    );
}

export function isOwnedConnectedDocumentPageImage(
    image: HTMLImageElement,
    pageNumber: number,
    openingTarget: HTMLElement | null,
) {
    if (openingTarget) {
        return image.parentElement === openingTarget && openingTarget.isConnected;
    }
    const page = image.closest<HTMLElement>('[data-testid="document-page-source-page"]');
    return Boolean(page?.isConnected && page.dataset.pageNumber === String(pageNumber));
}

export function findConnectedDocumentPageImage(query: IConnectedPageImageQuery) {
    const candidates = query.openingTarget
        ? query.openingTarget.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]')
        : query.viewerContainer?.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]');
    return [...(candidates ?? [])].find(image => (
        image.dataset.pageRenderGeneration === String(query.renderGeneration)
        && image.dataset.documentLoadGeneration === String(query.loadGeneration)
        && isOwnedConnectedDocumentPageImage(image, query.pageNumber, query.openingTarget)
        && image.complete
        && image.naturalWidth > 0
    )) ?? null;
}

export function waitForDocumentPageImagePaint(image: HTMLImageElement, signal: AbortSignal) {
    if (signal.aborted || !image.isConnected) {
        return Promise.resolve(false);
    }
    if (document.visibilityState !== 'visible') {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let animationFrame: number | null = null;
        const finish = (painted: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            if (animationFrame !== null) cancelAnimationFrame(animationFrame);
            signal.removeEventListener('abort', handleAbort);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            resolve(painted);
        };
        const handleAbort = () => finish(false);
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') finish(true);
        };
        signal.addEventListener('abort', handleAbort, {once: true});
        document.addEventListener('visibilitychange', handleVisibilityChange);
        animationFrame = requestAnimationFrame(() => finish(true));
    });
}

export async function prepareDocumentPageSurface(
    surface: IDocumentSurfaceLease['surface'],
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    if (typeof surface !== 'string') {
        return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = surface;
    try {
        await image.decode();
    } catch (error) {
        if (!image.complete || image.naturalWidth <= 0) {
            throw error;
        }
    }
    signal.throwIfAborted();
}

export function resolveDocumentPageSourcePageStyle(
    metrics: IDocumentPageMetrics,
    effectiveZoom: number,
    pageTop: number | undefined,
    gutterPx: number,
    continuousScroll: boolean,
    isCurrentPage: boolean,
) {
    const width = metrics.widthPoints * effectiveZoom;
    const height = metrics.heightPoints * effectiveZoom;
    return {
        width: `${String(width)}px`,
        height: `${String(height)}px`,
        top: `${String(continuousScroll ? pageTop ?? gutterPx : gutterPx)}px`,
        left: `max(${String(gutterPx)}px, calc(50% - ${String(width / 2)}px))`,
        display: !continuousScroll && !isCurrentPage ? 'none' : undefined,
    };
}
