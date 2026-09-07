import type {
    IPdfDocument,
    IPdfPage,
    IPdfViewport,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

interface IPdfjsViewportLike {
    convertToViewportPoint: (x: number, y: number) => readonly number[];
    clone?: (options?: unknown) => IPdfjsViewportLike;
}

interface IPdfjsPageLike {getViewport?: (options: unknown) => IPdfjsViewportLike;}

interface IPdfjsDocumentLike {
    getPage?: (pageNumber: number) => Promise<IPdfjsPageLike>;
    cleanup?: () => Promise<void>;
    destroy?: () => Promise<void>;
}

type TDocumentDestroy = (() => Promise<void>) | undefined;

const COMPATIBILITY_MARKER = Symbol('evbPdfjsCompatibility');

function hasCompatibilityMarker(value: object) {
    return Boolean((value as Record<PropertyKey, unknown>)[COMPATIBILITY_MARKER]);
}

function markCompatible<T extends object>(value: T) {
    Object.defineProperty(value, COMPATIBILITY_MARKER, {
        configurable: false,
        enumerable: false,
        value: true,
    });
    return value;
}

export function adaptPdfjsViewport<T extends object>(viewport: T): T & IPdfViewport {
    const compatibleViewport = viewport as T & IPdfjsViewportLike;
    if (hasCompatibilityMarker(viewport)) {
        return viewport as T & IPdfViewport;
    }

    if (typeof compatibleViewport.convertToViewportPoint !== 'function') {
        return markCompatible(viewport) as T & IPdfViewport;
    }

    if (typeof (compatibleViewport as IPdfjsViewportLike & {convertToViewportRectangle?: unknown}).convertToViewportRectangle !== 'function') {
        Object.defineProperty(viewport, 'convertToViewportRectangle', {
            configurable: true,
            value(rect: readonly number[]) {
                const [
                    x1,
                    y1,
                ] = compatibleViewport.convertToViewportPoint(
                    rect[0] as number,
                    rect[1] as number,
                );
                const [
                    x2,
                    y2,
                ] = compatibleViewport.convertToViewportPoint(
                    rect[2] as number,
                    rect[3] as number,
                );
                return [
                    x1,
                    y1,
                    x2,
                    y2,
                ];
            },
        });
    }

    const originalClone = compatibleViewport.clone?.bind(viewport);
    if (originalClone) {
        Object.defineProperty(viewport, 'clone', {
            configurable: true,
            value(options?: unknown) {
                return adaptPdfjsViewport(originalClone(options));
            },
        });
    }

    return markCompatible(viewport) as T & IPdfViewport;
}

export function adaptPdfjsPage<T extends object>(page: T): T & IPdfPage {
    const compatiblePage = page as T & IPdfjsPageLike;
    if (hasCompatibilityMarker(page)) {
        return page as T & IPdfPage;
    }

    const originalGetViewport = compatiblePage.getViewport?.bind(page);
    if (!originalGetViewport) {
        return markCompatible(page) as T & IPdfPage;
    }
    Object.defineProperty(page, 'getViewport', {
        configurable: true,
        value(options: unknown) {
            return adaptPdfjsViewport(originalGetViewport(options));
        },
    });

    return markCompatible(page) as T & IPdfPage;
}

export function adaptPdfjsDocument<T extends object>(
    document: T,
    destroyLoadingTask?: TDocumentDestroy,
): T & IPdfDocument {
    if (hasCompatibilityMarker(document)) {
        return document as T & IPdfDocument;
    }

    const compatibleDocument = document as T & IPdfjsDocumentLike;
    const originalGetPage = compatibleDocument.getPage?.bind(document);
    if (originalGetPage) {
        Object.defineProperty(document, 'getPage', {
            configurable: true,
            value(pageNumber: number) {
                return originalGetPage(pageNumber).then(page => adaptPdfjsPage(page));
            },
        });
    }

    const originalCleanup = compatibleDocument.cleanup?.bind(document);
    const originalDestroy = compatibleDocument.destroy?.bind(document);
    if (!originalDestroy) {
        Object.defineProperty(document, 'destroy', {
            configurable: true,
            value: async () => {
                try {
                    await originalCleanup?.();
                } finally {
                    await destroyLoadingTask?.();
                }
            },
        });
    }

    return markCompatible(document) as T & IPdfDocument;
}
