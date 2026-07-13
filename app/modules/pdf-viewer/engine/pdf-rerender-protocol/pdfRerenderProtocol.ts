export const PDF_RERENDER_SOURCE = {
    DprChange: 'dpr-change',
    FitHeightCurrentPage: 'fit-height-current-page',
    FitHeightPagedTarget: 'fit-height-paged-target',
    FitMode: 'fit-mode',
    FitWidthCurrentPage: 'fit-width-current-page',
    FitWidthExplicit: 'fit-width-explicit',
    FitWidthPagedTarget: 'fit-width-paged-target',
    ReRender: 're-render',
    ResizeObserver: 'resize-observer',
    ResizeSettle: 'resize-settle',
    Unknown: 'unknown',
    ViewMode: 'view-mode',
    ZoomChange: 'zoom-change',
    ZoomGestureChange: 'zoom-gesture-change',
    ZoomMode: 'zoom-mode',
    ZoomModeChange: 'zoom-mode-change',
} as const;

export type TPdfRerenderSource = typeof PDF_RERENDER_SOURCE[keyof typeof PDF_RERENDER_SOURCE];

interface IPdfRerenderSourcePolicy {
    anchoredCurrentPageSync: boolean;
    resize: boolean;
    useMinimalRenderBuffer: boolean;
    zoomRestore: boolean;
}

export const PDF_RERENDER_SOURCE_VALUES = Object.values(PDF_RERENDER_SOURCE) as readonly TPdfRerenderSource[];

const PDF_RERENDER_SOURCE_SET: ReadonlySet<string> = new Set(PDF_RERENDER_SOURCE_VALUES);

const PDF_RERENDER_SOURCE_POLICY = {
    [PDF_RERENDER_SOURCE.DprChange]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitHeightCurrentPage]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitHeightPagedTarget]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitMode]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitWidthCurrentPage]: {
        anchoredCurrentPageSync: true,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitWidthExplicit]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.FitWidthPagedTarget]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ReRender]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ResizeObserver]: {
        anchoredCurrentPageSync: true,
        resize: true,
        useMinimalRenderBuffer: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ResizeSettle]: {
        anchoredCurrentPageSync: true,
        resize: true,
        useMinimalRenderBuffer: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.Unknown]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ViewMode]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: false,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ZoomChange]: {
        anchoredCurrentPageSync: true,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: true,
    },
    [PDF_RERENDER_SOURCE.ZoomGestureChange]: {
        anchoredCurrentPageSync: true,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: true,
    },
    [PDF_RERENDER_SOURCE.ZoomMode]: {
        anchoredCurrentPageSync: false,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: false,
    },
    [PDF_RERENDER_SOURCE.ZoomModeChange]: {
        anchoredCurrentPageSync: true,
        resize: false,
        useMinimalRenderBuffer: true,
        zoomRestore: true,
    },
} satisfies Record<TPdfRerenderSource, IPdfRerenderSourcePolicy>;

export function isPdfRerenderSource(source: string | null | undefined): source is TPdfRerenderSource {
    return typeof source === 'string' && PDF_RERENDER_SOURCE_SET.has(source);
}

export function normalizePdfRerenderSource(
    source: string | null | undefined,
    fallback: TPdfRerenderSource = PDF_RERENDER_SOURCE.Unknown,
) {
    if (!source) {
        return fallback;
    }
    return isPdfRerenderSource(source)
        ? source
        : PDF_RERENDER_SOURCE.Unknown;
}

function getPdfRerenderSourcePolicy(source: string | null | undefined) {
    return PDF_RERENDER_SOURCE_POLICY[normalizePdfRerenderSource(source)];
}

export function isAnchoredCurrentPageSyncPdfRerenderSource(source: string | null | undefined) {
    return getPdfRerenderSourcePolicy(source).anchoredCurrentPageSync;
}

export function isResizePdfRerenderSource(source: string | null | undefined) {
    return getPdfRerenderSourcePolicy(source).resize;
}

export function shouldUseMinimalPdfRerenderBuffer(source: string | null | undefined) {
    return getPdfRerenderSourcePolicy(source).useMinimalRenderBuffer;
}

export function isZoomRestorePdfRerenderSource(source: string | null | undefined) {
    return getPdfRerenderSourcePolicy(source).zoomRestore;
}
