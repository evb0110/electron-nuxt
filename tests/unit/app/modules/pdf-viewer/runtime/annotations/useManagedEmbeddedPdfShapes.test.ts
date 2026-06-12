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

function createRenderedViewerContainer() {
    return Object.assign(Object.create(null), {
        querySelector: (selector: string) => (
            selector === '.page_container--rendered .page_canvas canvas'
                ? {}
                : null
        ),
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
});
