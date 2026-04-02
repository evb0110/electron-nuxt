import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    refreshDeletedEmbeddedShapePage,
    removeEmbeddedShapeAnnotationDom,
    rerenderRenderedManagedEmbeddedShapePages,
} from '@app/composables/pdf/pdfEmbeddedShapeRefresh';

interface IFakeAnnotationElement {
    dataset: { annotationId?: string; };
    remove: ReturnType<typeof vi.fn>;
    closest: (selector: string) => IFakeAnnotationElement | null;
}

interface IFakeViewerContainer {
    elements: IFakeAnnotationElement[];
    popups: IFakeAnnotationElement[];
    querySelectorAll: (selector: string) => IFakeAnnotationElement[];
}

function createFakeAnnotationElement(annotationId: string): IFakeAnnotationElement {
    const element: IFakeAnnotationElement = {
        dataset: { annotationId },
        remove: vi.fn(),
        closest: () => element,
    };
    return element;
}

function createFakePopup(parentAnnotationId: string): IFakeAnnotationElement {
    const parent = createFakeAnnotationElement(parentAnnotationId);
    return {
        dataset: { annotationId: `popup-${parentAnnotationId}` },
        remove: vi.fn(),
        closest: (selector: string) => selector === '[data-annotation-id]' ? parent : null,
    };
}

function createFakeViewerContainer(annotationIds: string[]): HTMLElement & IFakeViewerContainer {
    const elements = annotationIds.map(createFakeAnnotationElement);
    const popups = annotationIds.map(createFakePopup);

    return {
        elements,
        popups,
        querySelectorAll: (selector: string) => {
            const exactMatch = selector.match(/^\[data-annotation-id="(.+)"\]$/);
            if (exactMatch) {
                return elements.filter(element => element.dataset.annotationId === exactMatch[1]);
            }
            if (selector === '[data-annotation-id]') {
                return elements;
            }
            if (selector === '.annotationLayer .popup[data-annotation-id], .annotation-layer .popup[data-annotation-id]') {
                return popups;
            }
            return [];
        },
    } as HTMLElement & IFakeViewerContainer;
}

describe('refreshDeletedEmbeddedShapePage', () => {
    it('removes deleted embedded annotation DOM without rerendering the page', async () => {
        const syncHiddenEmbeddedAnnotationDom = vi.fn();
        const viewerContainer = createFakeViewerContainer(['12R']);

        refreshDeletedEmbeddedShapePage({
            shape: {
                annotationId: '12R0',
                pageIndex: 2,
                source: 'embedded',
            },
            viewerContainer,
            syncHiddenEmbeddedAnnotationDom,
        });

        await Promise.resolve();

        expect(syncHiddenEmbeddedAnnotationDom).toHaveBeenCalledOnce();
        expect(viewerContainer.elements[0]?.remove).toHaveBeenCalledOnce();
        expect(viewerContainer.popups[0]?.remove).toHaveBeenCalledOnce();
    });

    it('only syncs hidden annotation dom for local shapes', () => {
        const syncHiddenEmbeddedAnnotationDom = vi.fn();

        refreshDeletedEmbeddedShapePage({
            shape: {
                annotationId: null,
                pageIndex: 0,
                source: 'local',
            },
            viewerContainer: createFakeViewerContainer(['12R']),
            syncHiddenEmbeddedAnnotationDom,
        });

        expect(syncHiddenEmbeddedAnnotationDom).toHaveBeenCalledOnce();
    });
});

describe('removeEmbeddedShapeAnnotationDom', () => {
    it('removes annotation elements and related popups for the deleted embedded shape', () => {
        const viewerContainer = createFakeViewerContainer([
            '12R',
            'keep-me',
        ]);

        removeEmbeddedShapeAnnotationDom(viewerContainer, '12R0');

        expect(viewerContainer.elements[0]?.remove).toHaveBeenCalledOnce();
        expect(viewerContainer.popups[0]?.remove).toHaveBeenCalledOnce();
        expect(viewerContainer.elements[1]?.remove).not.toHaveBeenCalled();
        expect(viewerContainer.popups[1]?.remove).not.toHaveBeenCalled();
    });
});

describe('rerenderRenderedManagedEmbeddedShapePages', () => {
    it('rerenders the managed embedded shape pages that are already rendered', async () => {
        const renderVisiblePages = vi.fn(async () => {});
        const isPageRendered = vi.fn((pageNumber: number) => pageNumber === 1 || pageNumber === 3);

        rerenderRenderedManagedEmbeddedShapePages({
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
            isPageRendered,
            renderVisiblePages,
        });

        await Promise.resolve();

        expect(isPageRendered).toHaveBeenCalledWith(1);
        expect(isPageRendered).toHaveBeenCalledWith(3);
        expect(isPageRendered).toHaveBeenCalledWith(6);
        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 3,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });

    it('skips rerender when there are no rendered managed embedded shapes', () => {
        const renderVisiblePages = vi.fn(async () => {});
        const isPageRendered = vi.fn(() => false);

        rerenderRenderedManagedEmbeddedShapePages({
            shapes: [{
                annotationId: '22R0',
                pageIndex: 8,
                source: 'embedded',
            }],
            isPageRendered,
            renderVisiblePages,
        });

        expect(renderVisiblePages).not.toHaveBeenCalled();
    });
});
