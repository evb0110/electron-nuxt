import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
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

    it('focuses a shape without selecting it for editing or marking the document dirty', () => {
        const shapes = useAnnotationShapes();
        const embeddedShape = createEmbeddedShape();

        shapes.loadShapes([embeddedShape]);
        shapes.selectShape(embeddedShape.id);

        shapes.focusShape(embeddedShape.id);

        expect(shapes.focusedShapeId.value).toBe(embeddedShape.id);
        expect(shapes.selectedShapeId.value).toBeNull();
        expect(shapes.hasShapes.value).toBe(false);
    });

    it('clears sidebar focus when a shape is selected or deleted', () => {
        const shapes = useAnnotationShapes();
        const embeddedShape = createEmbeddedShape();

        shapes.loadShapes([embeddedShape]);
        shapes.focusShape(embeddedShape.id);
        shapes.selectShape(embeddedShape.id);

        expect(shapes.focusedShapeId.value).toBeNull();
        expect(shapes.selectedShapeId.value).toBe(embeddedShape.id);

        shapes.focusShape(embeddedShape.id);
        shapes.deleteShape(embeddedShape.id);

        expect(shapes.focusedShapeId.value).toBeNull();
        expect(shapes.selectedShapeId.value).toBeNull();
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

    it('creates draw strokes as local Ink polylines before save without auto-selecting them', () => {
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
        expect(shapes.selectedShapeId.value).toBeNull();
        expect(shapes.hasShapes.value).toBe(true);
    });

    it('timestamps created drawings and updates their modified time on edits', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-25T10:00:00Z'));

        try {
            const shapes = useAnnotationShapes();
            shapes.startDrawing(0, 'rectangle', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);

            vi.setSystemTime(new Date('2026-05-25T10:01:00Z'));
            shapes.continueDrawing(0.3, 0.4);
            const created = shapes.finishDrawing();

            expect(created).not.toBeNull();
            expect(created?.createdAt).toBe(new Date('2026-05-25T10:00:00Z').getTime());
            expect(created?.modifiedAt).toBe(new Date('2026-05-25T10:01:00Z').getTime());

            vi.setSystemTime(new Date('2026-05-25T10:02:00Z'));
            shapes.updateShape(created!.id, { color: '#ff0000' });

            const updated = shapes.getShapeById(created!.id);
            expect(updated?.createdAt).toBe(created?.createdAt);
            expect(updated?.modifiedAt).toBe(new Date('2026-05-25T10:02:00Z').getTime());
        } finally {
            vi.useRealTimers();
        }
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

    it('primes a freshly saved local draw stroke onto the imported embedded shape while preserving dirty state until save completes', () => {
        const shapes = useAnnotationShapes();

        shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.15, 0.25);
        shapes.continueDrawing(0.25, 0.35);

        const created = shapes.finishDrawing();
        expect(created).not.toBeNull();
        expect(shapes.hasShapes.value).toBe(true);

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

        shapes.primePersistedShapes([importedEmbeddedInkShape]);

        expect(shapes.getShapeById(created!.id)).toMatchObject({
            id: created!.id,
            source: 'embedded',
            annotationId: '21R',
            stableKey: created!.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(shapes.hasShapes.value).toBe(true);
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
        expect(shapes.getShapeById(created!.id)?.points).toEqual(importedEmbeddedInkShape.points);
        expect(shapes.getShapeById(created!.id)?.strokes).toEqual(importedEmbeddedInkShape.strokes);
        expect(shapes.getShapeById(created!.id)?.x).toBe(importedEmbeddedInkShape.x);
        expect(shapes.getShapeById(created!.id)?.y).toBe(importedEmbeddedInkShape.y);
        expect(shapes.hasShapes.value).toBe(false);
    });

    it('uses the imported managed shape geometry as the saved baseline after same-file reconciliation', () => {
        const shapes = useAnnotationShapes();
        const embeddedInkShape = createEmbeddedInkShape({
            id: 'shape-current-ink',
            stableKey: 'evb-shape:current-ink',
            annotationId: '21R',
            x: 0.18,
            y: 0.24,
            width: 0.19,
            height: 0.11,
            points: [
                {
                    x: 0.18,
                    y: 0.24,
                },
                {
                    x: 0.25,
                    y: 0.28,
                },
                {
                    x: 0.31,
                    y: 0.33,
                },
                {
                    x: 0.37,
                    y: 0.35,
                },
            ],
            strokes: [[
                {
                    x: 0.18,
                    y: 0.24,
                },
                {
                    x: 0.25,
                    y: 0.28,
                },
                {
                    x: 0.31,
                    y: 0.33,
                },
                {
                    x: 0.37,
                    y: 0.35,
                },
            ]],
        });

        shapes.loadShapes([embeddedInkShape]);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            id: 'shape-imported-ink',
            stableKey: embeddedInkShape.stableKey,
            annotationId: '44R',
            x: embeddedInkShape.x + 0.012,
            y: embeddedInkShape.y + 0.015,
            width: embeddedInkShape.width - 0.01,
            height: embeddedInkShape.height + 0.012,
            points: embeddedInkShape.points?.map(point => ({
                x: point.x + 0.012,
                y: point.y + 0.015,
            })),
            strokes: embeddedInkShape.strokes?.map(stroke => stroke.map(point => ({
                x: point.x + 0.012,
                y: point.y + 0.015,
            }))),
            strokeWidth: embeddedInkShape.strokeWidth + 2,
            opacity: 0.5,
        });

        shapes.reconcilePersistedShapes([importedEmbeddedInkShape]);

        expect(shapes.getShapeById(embeddedInkShape.id)).toEqual({
            ...importedEmbeddedInkShape,
            id: embeddedInkShape.id,
            source: 'embedded',
            annotationId: '44R',
            stableKey: embeddedInkShape.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(shapes.hasShapes.value).toBe(false);
    });

    it('keeps unmatched local shapes dirty when a late same-file import reconciles saved embedded shapes', () => {
        const shapes = useAnnotationShapes();
        const embeddedInkShape = createEmbeddedInkShape({
            id: 'shape-saved-ink',
            stableKey: 'evb-shape:saved-ink',
            annotationId: '41R',
        });
        const localInkShape = {...createEmbeddedInkShape({
            id: 'shape-local-ink',
            stableKey: 'evb-shape:local-ink',
            annotationId: undefined,
            source: 'local',
            x: 0.42,
            y: 0.18,
            width: 0.16,
            height: 0.15,
            color: '#22c55e',
            points: [
                {
                    x: 0.42,
                    y: 0.18,
                },
                {
                    x: 0.48,
                    y: 0.24,
                },
                {
                    x: 0.58,
                    y: 0.33,
                },
            ],
            strokes: [[
                {
                    x: 0.42,
                    y: 0.18,
                },
                {
                    x: 0.48,
                    y: 0.24,
                },
                {
                    x: 0.58,
                    y: 0.33,
                },
            ]],
        })} satisfies IShapeAnnotation;

        shapes.loadShapes([embeddedInkShape]);
        shapes.addShape(localInkShape);

        shapes.reconcilePersistedShapes([createEmbeddedInkShape({
            ...embeddedInkShape,
            annotationId: '52R',
            x: embeddedInkShape.x + 0.01,
            y: embeddedInkShape.y + 0.01,
        })]);

        expect(shapes.getShapeById(embeddedInkShape.id)).toMatchObject({
            id: embeddedInkShape.id,
            source: 'embedded',
            annotationId: '52R',
            stableKey: embeddedInkShape.stableKey,
        });
        expect(shapes.getShapeById(localInkShape.id)).toMatchObject({
            id: localInkShape.id,
            source: 'local',
            stableKey: localInkShape.stableKey,
        });
        expect(shapes.hasShapes.value).toBe(true);
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

    it('does not resurrect a just-deleted embedded shape when a stale import finishes after the delete', () => {
        const shapes = useAnnotationShapes();
        const firstEmbeddedInkShape = createEmbeddedInkShape();
        const secondEmbeddedInkShape = createEmbeddedInkShape({
            id: 'embedded-ink-2',
            annotationId: '22R',
            stableKey: 'evb-shape:embedded-ink-2',
            color: '#22c55e',
            x: 0.4,
            y: 0.28,
            width: 0.2,
            height: 0.16,
            points: [
                {
                    x: 0.4,
                    y: 0.28,
                },
                {
                    x: 0.5,
                    y: 0.34,
                },
                {
                    x: 0.6,
                    y: 0.44,
                },
            ],
            strokes: [[
                {
                    x: 0.4,
                    y: 0.28,
                },
                {
                    x: 0.5,
                    y: 0.34,
                },
                {
                    x: 0.6,
                    y: 0.44,
                },
            ]],
        });

        shapes.loadShapes([
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ]);
        shapes.deleteShape(secondEmbeddedInkShape.id);

        shapes.reconcilePersistedShapes([
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ]);

        expect(shapes.getAllShapes()).toHaveLength(1);
        expect(shapes.getAllShapes()[0]).toMatchObject({
            id: firstEmbeddedInkShape.id,
            stableKey: firstEmbeddedInkShape.stableKey,
            annotationId: firstEmbeddedInkShape.annotationId,
        });
        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['22R']);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-2']);
        expect(shapes.hasShapes.value).toBe(true);
    });

    it('restores a captured shape-state snapshot after a failed primed save attempt', () => {
        const shapes = useAnnotationShapes();

        shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.15, 0.25);
        shapes.continueDrawing(0.25, 0.35);

        const created = shapes.finishDrawing();
        expect(created).not.toBeNull();

        const snapshot = shapes.captureShapeStateSnapshot();
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

        shapes.primePersistedShapes([importedEmbeddedInkShape]);
        expect(shapes.getShapeById(created!.id)?.source).toBe('embedded');

        shapes.restoreShapeStateSnapshot(snapshot);

        expect(shapes.getShapeById(created!.id)).toMatchObject({
            id: created!.id,
            source: 'local',
            stableKey: created!.stableKey,
        });
        expect(shapes.hasShapes.value).toBe(true);
    });

    it('marks the current shapes as the saved baseline and clears deleted embedded tombstones', () => {
        const shapes = useAnnotationShapes();
        const firstEmbeddedInkShape = createEmbeddedInkShape();
        const secondEmbeddedInkShape = createEmbeddedInkShape({
            id: 'embedded-ink-2',
            annotationId: '22R',
            stableKey: 'evb-shape:embedded-ink-2',
            color: '#22c55e',
            x: 0.4,
            y: 0.28,
            width: 0.2,
            height: 0.16,
            points: [
                {
                    x: 0.4,
                    y: 0.28,
                },
                {
                    x: 0.5,
                    y: 0.34,
                },
                {
                    x: 0.6,
                    y: 0.44,
                },
            ],
            strokes: [[
                {
                    x: 0.4,
                    y: 0.28,
                },
                {
                    x: 0.5,
                    y: 0.34,
                },
                {
                    x: 0.6,
                    y: 0.44,
                },
            ]],
        });

        shapes.loadShapes([
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ]);
        shapes.deleteShape(firstEmbeddedInkShape.id);

        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(shapes.hasShapes.value).toBe(true);

        shapes.markSavedShapeState();

        expect(shapes.getAllShapes()).toEqual([secondEmbeddedInkShape]);
        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(shapes.hasShapes.value).toBe(false);
    });
});
