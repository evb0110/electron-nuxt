import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type { IShapeAnnotation } from '@app/types/annotations';
import { useAnnotationShapes } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { useManagedEmbeddedPdfShapes } from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';

vi.mock('@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations', async (importOriginal) => {
    const actual = await importOriginal<{importEmbeddedShapeAnnotations: typeof importEmbeddedShapeAnnotations;}>();
    return {
        ...actual,
        importEmbeddedShapeAnnotations: vi.fn(),
    };
});

class FakeNodeList<TElement extends Element> implements NodeListOf<TElement> {
    readonly length: number;

    [index: number]: TElement;

    constructor(private readonly elements: TElement[]) {
        this.length = elements.length;
        elements.forEach((element, index) => {
            this[index] = element;
        });
    }

    item(index: number) {
        const element = this.elements[index];
        if (!element) {
            throw new RangeError(`No fake node at index ${index}`);
        }
        return element;
    }

    forEach(
        callbackfn: (value: TElement, key: number, parent: NodeListOf<TElement>) => void,
        thisArg?: unknown,
    ) {
        this.elements.forEach((element, index) => {
            callbackfn.call(thisArg, element, index, this);
        });
    }

    entries() {
        return this.elements.entries();
    }

    keys() {
        return this.elements.keys();
    }

    values() {
        return this.elements.values();
    }

    [Symbol.iterator]() {
        return this.values();
    }
}

function createFakeNodeList<TElement extends Element>(elements: TElement[]) {
    return new FakeNodeList(elements);
}

function createRenderedViewerContainer(options: {
    hasShapeOverlay?: boolean;
    shapeOverlayAnnotationIds?: string[];
} = {}) {
    const overlayAnnotationIds = options.shapeOverlayAnnotationIds
        ?? (options.hasShapeOverlay ? ['12R'] : []);
    const overlayElements = overlayAnnotationIds.map(id => Object.assign(
        Object.create(null) as Element,
        {
            dataset: { annotationId: id },
            getAttribute: (name: string) => name === 'data-annotation-id' ? id : null,
        },
    ));
    const pageContainer = Object.create(null) as HTMLElement & {
        querySelector: (selector: string) => object | null;
        querySelectorAll: (selector: string) => NodeListOf<Element>;
    };
    pageContainer.querySelector = (selector: string) => {
        if (selector === '.pdf-shape-overlay.has-shapes' && overlayElements.length > 0) {
            return {};
        }
        return null;
    };
    pageContainer.querySelectorAll = (selector: string) => (
        selector === '.pdf-shape-overlay.has-shapes [data-annotation-id]'
            ? createFakeNodeList(overlayElements)
            : createFakeNodeList([])
    );
    return Object.assign(Object.create(null), {
        querySelector: (selector: string) => {
            if (selector === '.page_container--rendered .page_canvas canvas') {
                return {};
            }
            if (selector === '.page_container[data-page="1"]') {
                return pageContainer;
            }
            return null;
        },
        querySelectorAll: () => [],
    }) as HTMLElement;
}

function createEmbeddedInkShape(overrides: Partial<IShapeAnnotation>): IShapeAnnotation {
    return {
        id: 'embedded-ink-1',
        type: 'polyline',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.15,
        height: 0.15,
        color: DEFAULT_ANNOTATION_SETTINGS.inkColor,
        opacity: DEFAULT_ANNOTATION_SETTINGS.inkOpacity,
        strokeWidth: DEFAULT_ANNOTATION_SETTINGS.inkThickness,
        points: [
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.15,
                y: 0.25,
            },
            {
                x: 0.25,
                y: 0.35,
            },
        ],
        strokes: [[
            {
                x: 0.1,
                y: 0.2,
            },
            {
                x: 0.15,
                y: 0.25,
            },
            {
                x: 0.25,
                y: 0.35,
            },
        ]],
        source: 'embedded',
        annotationId: '21R',
        stableKey: 'evb-shape:embedded-ink-1',
        pdfSubtype: 'Ink',
        ...overrides,
    };
}

describe('useManagedEmbeddedPdfShapes', () => {
    it('adopts same-source saved shape metadata without rerendering the visible canvas', async () => {
        const shapeComposable = useAnnotationShapes();
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset();
        importEmbeddedShapesMock
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => {
                const shape = shapeComposable.getAllShapes()[0];
                if (!shape) {
                    return [];
                }
                return [createEmbeddedInkShape({
                    annotationId: '42R',
                    stableKey: shape.stableKey,
                    x: shape.x + 0.02,
                    y: shape.y + 0.03,
                    width: shape.width + 0.04,
                    height: shape.height + 0.05,
                    points: shape.points?.map(point => ({
                        x: point.x + 0.02,
                        y: point.y + 0.03,
                    })),
                    strokes: shape.strokes?.map(stroke => stroke.map(point => ({
                        x: point.x + 0.02,
                        y: point.y + 0.03,
                    }))),
                })];
            });

        const viewerContainer = ref<HTMLElement | null>(createRenderedViewerContainer());
        const sourcePdfData = ref<Uint8Array | null>(new Uint8Array([1]));
        const invalidatePages = vi.fn();
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer,
            workingCopyPath: ref('/tmp/work.pdf'),
            sourcePdfData,
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            suppressCommentAnnotationId: vi.fn(),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: task => void Promise.resolve(task()),
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages,
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        await vi.waitFor(() => {
            expect(importEmbeddedShapesMock).toHaveBeenCalledTimes(1);
        });

        shapeComposable.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapeComposable.continueDrawing(0.15, 0.25);
        shapeComposable.continueDrawing(0.25, 0.35);
        const created = shapeComposable.finishDrawing();
        expect(created).not.toBeNull();

        const originalPoints = created!.points?.map(point => ({ ...point }));
        const originalStrokes = created!.strokes?.map(stroke => stroke.map(point => ({ ...point })));
        managedShapes.adoptPersistedManagedShapesOnNextImport();
        invalidatePages.mockClear();
        renderVisiblePages.mockClear();

        sourcePdfData.value = new Uint8Array([2]);

        await vi.waitFor(() => {
            expect(importEmbeddedShapesMock).toHaveBeenCalledTimes(2);
            expect(shapeComposable.getShapeById(created!.id)).toMatchObject({
                id: created!.id,
                source: 'embedded',
                annotationId: '42R',
                stableKey: created!.stableKey,
                x: created!.x,
                y: created!.y,
                width: created!.width,
                height: created!.height,
            });
        });

        expect(shapeComposable.getShapeById(created!.id)?.points).toEqual(originalPoints);
        expect(shapeComposable.getShapeById(created!.id)?.strokes).toEqual(originalStrokes);
        expect(shapeComposable.hasShapes.value).toBe(false);
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(renderVisiblePages).not.toHaveBeenCalled();
    });

    it('rerenders hidden annotation pages without invalidating the mounted canvas first', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const pendingTasks: Array<Promise<unknown>> = [];
        const invalidatePages = vi.fn();
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(null),
            workingCopyPath: ref(null),
            sourcePdfData: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable: useAnnotationShapes(),
            suppressCommentAnnotationId: vi.fn(),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: (task) => {
                pendingTasks.push(Promise.resolve(task()));
            },
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages,
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        managedShapes.refreshHiddenAnnotationPage({ pageNumber: 1 });
        await Promise.all(pendingTasks);

        expect(invalidatePages).not.toHaveBeenCalled();
        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 1,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });

    it('suppresses managed annotations from canvas before their page overlay is ready', async () => {
        const shapeComposable = useAnnotationShapes();
        const importEmbeddedShapesMock = vi.mocked(importEmbeddedShapeAnnotations);
        importEmbeddedShapesMock.mockReset();
        importEmbeddedShapesMock.mockResolvedValueOnce([createEmbeddedInkShape({ annotationId: '12R0' })]);
        const viewerContainer = ref<HTMLElement | null>(
            createRenderedViewerContainer({ hasShapeOverlay: false }),
        );
        const pendingTasks: Array<Promise<unknown>> = [];
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer,
            workingCopyPath: ref('/tmp/work.pdf'),
            sourcePdfData: ref<Uint8Array | null>(new Uint8Array([1])),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable,
            suppressCommentAnnotationId: vi.fn(),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: (task) => {
                pendingTasks.push(Promise.resolve(task()));
            },
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages: vi.fn(),
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        await vi.waitFor(() => {
            expect(importEmbeddedShapesMock).toHaveBeenCalledOnce();
            expect(managedShapes.hiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);
        });
        await vi.waitFor(() => {
            expect(renderVisiblePages).toHaveBeenCalled();
        });
        renderVisiblePages.mockClear();

        expect(managedShapes.renderHiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);

        viewerContainer.value = createRenderedViewerContainer({
            hasShapeOverlay: true,
            shapeOverlayAnnotationIds: ['34R'],
        });
        managedShapes.syncAfterPageRendered(1);

        expect(managedShapes.renderHiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);

        viewerContainer.value = createRenderedViewerContainer({ hasShapeOverlay: true });
        managedShapes.syncAfterPageRendered(1);

        expect(managedShapes.renderHiddenEmbeddedAnnotationIds.value.has('12R')).toBe(true);
        await Promise.all(pendingTasks);
        expect(renderVisiblePages).not.toHaveBeenCalled();
    });
});
