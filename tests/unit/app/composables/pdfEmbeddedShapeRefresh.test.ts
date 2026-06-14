import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { refreshDeletedEmbeddedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/refreshDeletedEmbeddedShapePage';
import { removeEmbeddedShapeAnnotationDom } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/removeEmbeddedShapeAnnotationDom';
import { rerenderRenderedManagedEmbeddedShapePages } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/rerenderRenderedManagedEmbeddedShapePages';
import { shouldRefreshManagedShapePage } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/shouldRefreshManagedShapePage';
import {
    resolveHiddenEmbeddedAnnotationIdsForPageContainer,
    syncHiddenEmbeddedAnnotationDom,
} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-refresh/syncHiddenEmbeddedAnnotationDom';

interface IFakeEmbeddedShapeAnnotationElement {
    dataset: { annotationId?: string; };
    getAttribute?: (name: string) => string | null;
    remove: ReturnType<typeof vi.fn>;
    closest: (selector: string) => Element | IFakeEmbeddedShapeAnnotationElement | null;
}

interface IFakeViewerContainer {
    elements: IFakeEmbeddedShapeAnnotationElement[];
    overlayElements: IFakeEmbeddedShapeAnnotationElement[];
    popups: IFakeEmbeddedShapeAnnotationElement[];
    querySelectorAll: (selector: string) => IFakeEmbeddedShapeAnnotationElement[];
}

function createFakeAnnotationElement(annotationId: string): IFakeEmbeddedShapeAnnotationElement {
    const element: IFakeEmbeddedShapeAnnotationElement = {
        dataset: { annotationId },
        remove: vi.fn(),
        closest: (selector: string) => selector === '[data-annotation-id]' ? element : null,
    };
    return element;
}

function createFakeShapeOverlayAnnotationElement(annotationId: string): IFakeEmbeddedShapeAnnotationElement {
    const overlay = Object.assign(Object.create(null) as Element, { classList: { contains: () => false } });
    const element: IFakeEmbeddedShapeAnnotationElement = {
        dataset: { annotationId },
        getAttribute: (name: string) => name === 'data-annotation-id' ? annotationId : null,
        remove: vi.fn(),
        closest: (selector: string) => {
            if (selector === '.pdf-shape-overlay' || selector === '.pdf-shape-overlay.has-shapes') {
                return overlay;
            }
            if (selector === '[data-annotation-id]') {
                return element;
            }
            return null;
        },
    };
    return element;
}

function createFakePopup(parentAnnotationId: string): IFakeEmbeddedShapeAnnotationElement {
    const parent = createFakeAnnotationElement(parentAnnotationId);
    return {
        dataset: { annotationId: `popup-${parentAnnotationId}` },
        remove: vi.fn(),
        closest: (selector: string) => selector === '[data-annotation-id]' ? parent : null,
    };
}

function createFakeViewerContainer(
    annotationIds: string[],
    options: { shapeOverlayAnnotationIds?: string[] } = {},
): HTMLElement & IFakeViewerContainer {
    const elements = annotationIds.map(createFakeAnnotationElement);
    const overlayElements = (options.shapeOverlayAnnotationIds ?? [])
        .map(createFakeShapeOverlayAnnotationElement);
    const popups = annotationIds.map(createFakePopup);

    return {
        elements,
        overlayElements,
        popups,
        querySelectorAll: (selector: string) => {
            const exactMatch = selector.match(/^\[data-annotation-id="(.+)"\]$/);
            if (exactMatch) {
                return elements.filter(element => element.dataset.annotationId === exactMatch[1]);
            }
            if (selector === '[data-annotation-id]') {
                return [
                    ...elements,
                    ...overlayElements,
                ];
            }
            if (selector === '.annotationLayer .popup[data-annotation-id], .annotation-layer .popup[data-annotation-id]') {
                return popups;
            }
            return [];
        },
    } as HTMLElement & IFakeViewerContainer;
}

function createFakeHiddenAnnotationContainer(
    annotationId: string,
    options: {
        hasShapeOverlay: boolean;
        includeShapeOverlayInContainerQuery?: boolean;
        shapeOverlayAnnotationIds?: string[];
    },
) {
    const overlayAnnotationIds = options.shapeOverlayAnnotationIds
        ?? (options.hasShapeOverlay ? [annotationId] : []);
    const overlayElements = overlayAnnotationIds.map(createFakeShapeOverlayAnnotationElement);
    const querySelector = (selector: string) => (
        selector === '.pdf-shape-overlay.has-shapes' && overlayElements.length > 0
            ? Object.create(null)
            : null
    );
    const querySelectorAll = (selector: string) => (
        selector === '.pdf-shape-overlay.has-shapes [data-annotation-id]'
            ? overlayElements
            : []
    );
    const pageContainer = Object.assign(Object.create(null) as HTMLElement, {
        querySelector,
        querySelectorAll,
    });
    const element = Object.assign(Object.create(null) as HTMLElement, {
        closest: (selector: string) => {
            if (selector === '.page_container') {
                return pageContainer;
            }
            if (selector === '[data-annotation-id]') {
                return element;
            }
            return null;
        },
        dataset: { annotationId },
        getAttribute: (name: string) => name === 'data-annotation-id' ? annotationId : null,
        remove: vi.fn(),
    });
    const containerQuerySelectorAll = (selector: string) => selector === '[data-annotation-id]'
        ? [
            element,
            ...(options.includeShapeOverlayInContainerQuery ? overlayElements : []),
        ]
        : [];
    const container = Object.assign(Object.create(null) as HTMLElement, { querySelectorAll: containerQuerySelectorAll });

    return {
        container,
        element,
        overlayElements,
        pageContainer,
    };
}

describe('refreshDeletedEmbeddedShapePage', () => {
    it('removes deleted embedded annotation DOM and requests a repaint for the affected page', async () => {
        const syncHiddenEmbeddedAnnotationDom = vi.fn();
        const rerenderEmbeddedShapePage = vi.fn();
        const viewerContainer = createFakeViewerContainer(['12R']);

        refreshDeletedEmbeddedShapePage({
            shape: {
                annotationId: '12R0',
                pageIndex: 2,
                source: 'embedded',
            },
            viewerContainer,
            syncHiddenEmbeddedAnnotationDom,
            rerenderEmbeddedShapePage,
        });

        await Promise.resolve();

        expect(syncHiddenEmbeddedAnnotationDom).toHaveBeenCalledOnce();
        expect(viewerContainer.elements[0]?.remove).toHaveBeenCalledOnce();
        expect(viewerContainer.popups[0]?.remove).toHaveBeenCalledOnce();
        expect(rerenderEmbeddedShapePage).toHaveBeenCalledWith(3);
    });

    it('only syncs hidden annotation dom for local shapes', () => {
        const syncHiddenEmbeddedAnnotationDom = vi.fn();
        const rerenderEmbeddedShapePage = vi.fn();

        refreshDeletedEmbeddedShapePage({
            shape: {
                annotationId: null,
                pageIndex: 0,
                source: 'local',
            },
            viewerContainer: createFakeViewerContainer(['12R']),
            syncHiddenEmbeddedAnnotationDom,
            rerenderEmbeddedShapePage,
        });

        expect(syncHiddenEmbeddedAnnotationDom).toHaveBeenCalledOnce();
        expect(rerenderEmbeddedShapePage).not.toHaveBeenCalled();
    });
});

describe('removeEmbeddedShapeAnnotationDom', () => {
    it('removes annotation elements and related popups for the deleted embedded shape', () => {
        const viewerContainer = createFakeViewerContainer([
            '12R',
            'keep-me',
        ], { shapeOverlayAnnotationIds: ['12R'] });

        removeEmbeddedShapeAnnotationDom(viewerContainer, '12R0');

        expect(viewerContainer.elements[0]?.remove).toHaveBeenCalledOnce();
        expect(viewerContainer.popups[0]?.remove).toHaveBeenCalledOnce();
        expect(viewerContainer.overlayElements[0]?.remove).not.toHaveBeenCalled();
        expect(viewerContainer.elements[1]?.remove).not.toHaveBeenCalled();
        expect(viewerContainer.popups[1]?.remove).not.toHaveBeenCalled();
    });
});

describe('syncHiddenEmbeddedAnnotationDom', () => {
    it('keeps managed embedded annotation DOM until the shape overlay is mounted', () => {
        const {
            container,
            element,
        } = createFakeHiddenAnnotationContainer('12R', { hasShapeOverlay: false });

        const result = syncHiddenEmbeddedAnnotationDom({
            container,
            hiddenAnnotationIds: new Set(['12R0']),
            managedAnnotationIds: new Set(['12R']),
        });

        expect(element.remove).not.toHaveBeenCalled();
        expect(result).toEqual({
            removedCount: 0,
            deferredManagedAnnotationCount: 1,
        });
    });

    it('keeps managed embedded annotation DOM when only a different shape overlay is mounted', () => {
        const {
            container,
            element,
        } = createFakeHiddenAnnotationContainer('12R', {
            hasShapeOverlay: true,
            shapeOverlayAnnotationIds: ['34R'],
        });

        const result = syncHiddenEmbeddedAnnotationDom({
            container,
            hiddenAnnotationIds: new Set(['12R0']),
            managedAnnotationIds: new Set(['12R']),
        });

        expect(element.remove).not.toHaveBeenCalled();
        expect(result).toEqual({
            removedCount: 0,
            deferredManagedAnnotationCount: 1,
        });
    });

    it('removes managed embedded annotation DOM once the matching shape overlay is mounted', () => {
        const {
            container,
            element,
            overlayElements,
        } = createFakeHiddenAnnotationContainer('12R', {
            hasShapeOverlay: true,
            includeShapeOverlayInContainerQuery: true,
            shapeOverlayAnnotationIds: ['12R'],
        });

        const result = syncHiddenEmbeddedAnnotationDom({
            container,
            hiddenAnnotationIds: new Set(['12R0']),
            managedAnnotationIds: new Set(['12R']),
        });

        expect(element.remove).toHaveBeenCalledOnce();
        expect(overlayElements[0]?.remove).not.toHaveBeenCalled();
        expect(result).toEqual({
            removedCount: 1,
            deferredManagedAnnotationCount: 0,
        });
    });

    it('removes deleted embedded annotation DOM without waiting for a shape overlay', () => {
        const {
            container,
            element,
        } = createFakeHiddenAnnotationContainer('12R', { hasShapeOverlay: false });

        const result = syncHiddenEmbeddedAnnotationDom({
            container,
            hiddenAnnotationIds: new Set(['12R0']),
            managedAnnotationIds: new Set(),
        });

        expect(element.remove).toHaveBeenCalledOnce();
        expect(result).toEqual({
            removedCount: 1,
            deferredManagedAnnotationCount: 0,
        });
    });
});

describe('resolveHiddenEmbeddedAnnotationIdsForPageContainer', () => {
    it('keeps active managed embedded annotations visible until their page overlay is mounted', () => {
        const { pageContainer } = createFakeHiddenAnnotationContainer('12R', { hasShapeOverlay: false });
        const hiddenIds = resolveHiddenEmbeddedAnnotationIdsForPageContainer({
            hiddenAnnotationIds: new Set([
                '12R0',
                'deleted-annotation',
            ]),
            managedAnnotationIds: new Set(['12R']),
            pageContainer,
        });

        expect(hiddenIds.has('12R')).toBe(false);
        expect(hiddenIds.has('deleted-annotation')).toBe(true);
    });

    it('keeps active managed embedded annotations visible when only a different page overlay is mounted', () => {
        const { pageContainer } = createFakeHiddenAnnotationContainer('12R', {
            hasShapeOverlay: true,
            shapeOverlayAnnotationIds: ['34R'],
        });
        const hiddenIds = resolveHiddenEmbeddedAnnotationIdsForPageContainer({
            hiddenAnnotationIds: new Set(['12R0']),
            managedAnnotationIds: new Set(['12R']),
            pageContainer,
        });

        expect(hiddenIds.has('12R')).toBe(false);
    });

    it('hides managed embedded annotations once their matching page overlay is mounted', () => {
        const { pageContainer } = createFakeHiddenAnnotationContainer('12R', {
            hasShapeOverlay: true,
            shapeOverlayAnnotationIds: ['12R'],
        });
        const hiddenIds = resolveHiddenEmbeddedAnnotationIdsForPageContainer({
            hiddenAnnotationIds: new Set(['12R0']),
            managedAnnotationIds: new Set(['12R']),
            pageContainer,
        });

        expect(hiddenIds.has('12R')).toBe(true);
    });
});

describe('shouldRefreshManagedShapePage', () => {
    it('refreshes pages in the active render window even when render bookkeeping is stale', () => {
        expect(shouldRefreshManagedShapePage({
            pageNumber: 6,
            visibleRange: {
                start: 5,
                end: 5,
            },
            renderBuffer: 1,
            isPageRendered: () => false,
        })).toBe(true);
    });

    it('refreshes pages with mounted canvas dom even when they are not marked rendered', () => {
        expect(shouldRefreshManagedShapePage({
            pageNumber: 9,
            visibleRange: {
                start: 1,
                end: 1,
            },
            renderBuffer: 0,
            isPageRendered: () => false,
            hasRenderedCanvasDom: (pageNumber) => pageNumber === 9,
        })).toBe(true);
    });
});

describe('rerenderRenderedManagedEmbeddedShapePages', () => {
    it('rerenders managed embedded shape pages that are rendered or inside the active render window', async () => {
        const renderVisiblePages = vi.fn(async () => {});
        const invalidatePages = vi.fn();
        const isPageRendered = vi.fn((pageNumber: number) => pageNumber === 1 || pageNumber === 3);

        await rerenderRenderedManagedEmbeddedShapePages({
            shapes: [
                {
                    annotationId: '12R0',
                    pageIndex: 0,
                    source: 'embedded',
                },
                {
                    annotationId: '13R0',
                    pageIndex: 2,
                    source: 'embedded',
                },
                {
                    annotationId: '14R0',
                    pageIndex: 5,
                    source: 'embedded',
                },
            ],
            visibleRange: {
                start: 5,
                end: 5,
            },
            renderBuffer: 1,
            isPageRendered,
            invalidatePages,
            renderVisiblePages,
        });

        expect(isPageRendered).toHaveBeenCalledWith(1);
        expect(isPageRendered).toHaveBeenCalledWith(3);
        expect(isPageRendered).toHaveBeenCalledWith(6);
        expect(invalidatePages).toHaveBeenCalledWith([
            1,
            3,
            6,
        ]);
        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 6,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });

    it('skips rerender when there are no rendered managed embedded shapes', async () => {
        const renderVisiblePages = vi.fn(async () => {});
        const invalidatePages = vi.fn();
        const isPageRendered = vi.fn(() => false);

        await rerenderRenderedManagedEmbeddedShapePages({
            shapes: [{
                annotationId: '22R0',
                pageIndex: 8,
                source: 'embedded',
            }],
            visibleRange: {
                start: 1,
                end: 2,
            },
            renderBuffer: 0,
            isPageRendered,
            invalidatePages,
            renderVisiblePages,
        });

        expect(invalidatePages).not.toHaveBeenCalled();
        expect(renderVisiblePages).not.toHaveBeenCalled();
    });
});
