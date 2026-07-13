import type {
    IDocumentAnnotationRecord,
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

export function hasHigherDocumentRenderPriority(
    next: TDocumentRenderPriority,
    previous: TDocumentRenderPriority,
) {
    return DOCUMENT_RENDER_PRIORITY_RANK[next] > DOCUMENT_RENDER_PRIORITY_RANK[previous];
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

function getAnnotationNumber(payload: Readonly<Record<string, unknown>>, key: string, fallback: number) {
    const value = payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function getDocumentPageSourceAnnotationStyle(annotation: IDocumentAnnotationRecord) {
    const {payload} = annotation;
    return {
        left: `${getAnnotationNumber(payload, 'x', 0.08) * 100}%`,
        top: `${getAnnotationNumber(payload, 'y', 0.08) * 100}%`,
        width: `${getAnnotationNumber(payload, 'width', 0.18) * 100}%`,
        height: `${getAnnotationNumber(payload, 'height', 0.08) * 100}%`,
        borderColor: typeof payload.color === 'string' ? payload.color : '#f59e0b',
    };
}
