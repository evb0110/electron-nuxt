import {
    describe,
    expect,
    it,
} from 'vitest';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import type { IShapeAnnotation } from '@app/types/annotations';

function createEmbeddedShape(): IShapeAnnotation {
    return {
        id: 'embedded-shape-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.1,
        y: 0.15,
        width: 0.2,
        height: 0.25,
        color: '#336699',
        fillColor: '#abcdef',
        opacity: 0.6,
        strokeWidth: 3,
        source: 'embedded',
        annotationId: '12R0',
        stableKey: 'evb-shape:embedded-rect-1',
        pdfSubtype: 'Square',
    };
}

function createEmbeddedInkShape(overrides?: Partial<IShapeAnnotation>): IShapeAnnotation {
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

describe('useAnnotationShapes', () => {
    it('does not mark imported embedded shapes as dirty until they change', () => {
        const shapes = useAnnotationShapes();
        shapes.loadShapes([createEmbeddedShape()]);

        expect(shapes.hasShapes.value).toBe(false);

        shapes.updateShape('embedded-shape-1', { color: '#ff0000' });

        expect(shapes.hasShapes.value).toBe(true);
    });

    it('tracks deleted embedded annotation ids and clears them when the same shape is restored', () => {
        const shapes = useAnnotationShapes();
        const embeddedShape = createEmbeddedShape();

        shapes.loadShapes([embeddedShape]);
        shapes.deleteShape(embeddedShape.id);

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['12R0']);
        expect(shapes.hasShapes.value).toBe(true);

        shapes.addShape({ ...embeddedShape });

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(shapes.hasShapes.value).toBe(false);
    });

    it('creates draw strokes as local Ink polylines before save', () => {
        const shapes = useAnnotationShapes();

        shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.15, 0.25);
        shapes.continueDrawing(0.25, 0.35);

        const created = shapes.finishDrawing();

        expect(created).toMatchObject({
            type: 'polyline',
            source: 'local',
            pdfSubtype: 'Ink',
            color: DEFAULT_ANNOTATION_SETTINGS.inkColor,
            opacity: DEFAULT_ANNOTATION_SETTINGS.inkOpacity,
            strokeWidth: DEFAULT_ANNOTATION_SETTINGS.inkThickness,
        });
        expect(created?.stableKey).toMatch(/^evb-shape:/);
        expect(created?.strokes).toHaveLength(1);
        expect(created?.strokes?.[0]).toHaveLength(3);
        expect(shapes.selectedShapeId.value).toBe(created?.id ?? null);
        expect(shapes.hasShapes.value).toBe(true);
    });

    it('reconciles a freshly saved local draw stroke onto the imported embedded shape without changing its id', () => {
        const shapes = useAnnotationShapes();

        shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.15, 0.25);
        shapes.continueDrawing(0.25, 0.35);

        const created = shapes.finishDrawing();
        expect(created).not.toBeNull();

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            stableKey: created!.stableKey,
            x: created!.x,
            y: created!.y,
            width: created!.width,
            height: created!.height,
            color: created!.color,
            opacity: created!.opacity,
            strokeWidth: created!.strokeWidth,
            points: created!.points,
            strokes: created!.strokes,
        });

        shapes.reconcilePersistedShapes([importedEmbeddedInkShape]);

        expect(shapes.getShapeById(created!.id)).toMatchObject({
            id: created!.id,
            source: 'embedded',
            annotationId: '21R',
            stableKey: created!.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(shapes.hasShapes.value).toBe(false);
    });

    it('reconciles a persisted drawing by stable key when the saved annotation ref changes', () => {
        const shapes = useAnnotationShapes();

        shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.15, 0.25);
        shapes.continueDrawing(0.25, 0.35);

        const created = shapes.finishDrawing();
        expect(created).not.toBeNull();

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            annotationId: '44R',
            stableKey: created!.stableKey,
            x: created!.x + 0.0002,
            y: created!.y + 0.00015,
            width: created!.width,
            height: created!.height,
            color: created!.color,
            opacity: created!.opacity,
            strokeWidth: created!.strokeWidth,
            points: created!.points?.map(point => ({
                x: point.x + 0.0002,
                y: point.y + 0.00015,
            })),
            strokes: created!.strokes?.map(stroke => stroke.map(point => ({
                x: point.x + 0.0002,
                y: point.y + 0.00015,
            }))),
        });

        shapes.reconcilePersistedShapes([importedEmbeddedInkShape]);

        expect(shapes.getShapeById(created!.id)).toMatchObject({
            id: created!.id,
            source: 'embedded',
            annotationId: '44R',
            stableKey: created!.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(shapes.hasShapes.value).toBe(false);
    });

    it('keeps deleted embedded shape tombstones until the imported document no longer contains the deleted annotation', () => {
        const shapes = useAnnotationShapes();
        const embeddedInkShape = createEmbeddedInkShape();

        shapes.loadShapes([embeddedInkShape]);
        shapes.deleteShape(embeddedInkShape.id);

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(shapes.hasShapes.value).toBe(true);

        shapes.reconcilePersistedShapes([embeddedInkShape]);

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(shapes.hasShapes.value).toBe(true);

        shapes.reconcilePersistedShapes([]);

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(shapes.hasShapes.value).toBe(false);
    });
});
