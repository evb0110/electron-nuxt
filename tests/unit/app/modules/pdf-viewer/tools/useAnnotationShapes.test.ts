import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { useAnnotationShapes } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type { IShapeAnnotation } from '@app/types/annotations';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const IMPORT_SOURCE = {
    documentKey: 'doc-key',
    path: '/documents/doc.pdf',
};

function createShapeProjection() {
    const application = shallowRef(new AnnotationApplication('doc-key'));
    const scope = effectScope();
    const shapes = scope.run(() => useAnnotationShapes({
        annotationApplication: application,
        notifyShapeCommentsChanged: () => undefined,
    }))!;
    return {
        application,
        shapes,
        store: application.value.store,
    };
}

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

function drawLocalShape(projection: ReturnType<typeof createShapeProjection>, tool = 'draw' as const) {
    const {
        shapes,
        application,
    } = projection;
    shapes.startDrawing(0, tool, 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
    shapes.continueDrawing(0.15, 0.25);
    shapes.continueDrawing(0.25, 0.35);
    const created = shapes.finishDrawing();
    expect(created).not.toBeNull();
    application.value.createShapeFromGeometry(created!);
    return created!;
}

function deleteShape(projection: ReturnType<typeof createShapeProjection>, shapeId: string) {
    const annotationId = projection.application.value.annotationIdForShape({
        id: shapeId,
        annotationId: projection.shapes.getShapeById(shapeId)?.annotationId ?? null,
    });
    expect(annotationId).not.toBeNull();
    projection.application.value.store.delete(annotationId!);
}

describe('useAnnotationShapes', () => {
    it('renders the canonical store shapes instead of a second shape map', () => {
        const projection = createShapeProjection();
        projection.shapes.importEmbeddedShapes([createEmbeddedShape()], IMPORT_SOURCE);

        const [projected] = projection.shapes.getAllShapes();
        expect(projected).toMatchObject({
            id: 'embedded-shape-1',
            source: 'embedded',
        });

        // A projection copy is not authority: mutating it cannot change what the
        // store renders next.
        projected!.color = '#000000';
        expect(projection.shapes.getShapeById('embedded-shape-1')?.color).toBe('#336699');

        const entity = projection.application.value.store.listShapes()[0]!;
        projection.application.value.replaceShapeGeometry(entity.identity.id, {
            ...entity.geometry,
            color: '#ff0000',
        });
        expect(projection.shapes.getShapeById('embedded-shape-1')?.color).toBe('#ff0000');
        expect(projection.shapes.getShapesForPage(0)).toHaveLength(1);
    });

    it('does not mark imported embedded shapes as dirty until they change', () => {
        const projection = createShapeProjection();
        projection.shapes.importEmbeddedShapes([createEmbeddedShape()], IMPORT_SOURCE);

        expect(projection.shapes.hasShapes.value).toBe(false);

        const entity = projection.application.value.store.listShapes()[0]!;
        projection.application.value.replaceShapeGeometry(entity.identity.id, {
            ...entity.geometry,
            color: '#ff0000',
        });

        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('reports shape dirty state without reacting to note mutations', () => {
        const projection = createShapeProjection();
        projection.shapes.importEmbeddedShapes([createEmbeddedShape()], IMPORT_SOURCE);

        const note = projection.application.value.store.createStickyNote({
            kind: 'sticky-note',
            identity: {id: asAnnotationId('shape-dirty-note')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            text: 'note',
            anchor: {
                left: 0.1,
                top: 0.1,
                width: 0.1,
                height: 0.1,
            },
            color: null,
            createdAt: null,
            modifiedAt: null,
            author: null,
        });
        projection.application.value.store.setNoteText(note.identity.id, 'edited');

        expect(projection.store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('focuses a shape without selecting it for editing or marking the document dirty', () => {
        const projection = createShapeProjection();
        const embeddedShape = createEmbeddedShape();
        projection.shapes.importEmbeddedShapes([embeddedShape], IMPORT_SOURCE);
        projection.shapes.selectShape(embeddedShape.id);

        projection.shapes.focusShape(embeddedShape.id);

        expect(projection.shapes.focusedShapeId.value).toBe(embeddedShape.id);
        expect(projection.shapes.selectedShapeId.value).toBeNull();
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('clears sidebar focus when a shape is selected or canonically deleted', () => {
        const projection = createShapeProjection();
        const embeddedShape = createEmbeddedShape();

        projection.shapes.importEmbeddedShapes([embeddedShape], IMPORT_SOURCE);
        projection.shapes.focusShape(embeddedShape.id);
        projection.shapes.selectShape(embeddedShape.id);

        expect(projection.shapes.focusedShapeId.value).toBeNull();
        expect(projection.shapes.selectedShapeId.value).toBe(embeddedShape.id);

        projection.shapes.focusShape(embeddedShape.id);
        deleteShape(projection, embeddedShape.id);

        expect(projection.shapes.focusedShapeId.value).toBeNull();
        expect(projection.shapes.selectedShapeId.value).toBeNull();
    });

    it('derives deleted embedded refs from store tombstones and drops them when the delete is undone', () => {
        const projection = createShapeProjection();
        const embeddedShape = createEmbeddedShape();

        projection.shapes.importEmbeddedShapes([embeddedShape], IMPORT_SOURCE);
        deleteShape(projection, embeddedShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['12R0']);
        expect(projection.shapes.hasShapes.value).toBe(true);

        projection.store.undo();

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getAllShapes()).toHaveLength(1);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('creates draw strokes as local Ink polyline drafts before they enter the store', () => {
        const projection = createShapeProjection();

        projection.shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        projection.shapes.continueDrawing(0.15, 0.25);
        projection.shapes.continueDrawing(0.25, 0.35);

        const created = projection.shapes.finishDrawing();

        expect(created).toMatchObject({
            type: 'polyline',
            source: 'local',
            pdfSubtype: 'Ink',
            color: DEFAULT_ANNOTATION_SETTINGS.inkColor,
            opacity: DEFAULT_ANNOTATION_SETTINGS.inkOpacity,
            strokeWidth: DEFAULT_ANNOTATION_SETTINGS.inkThickness,
        });
        expect(created?.stableKey).toMatch(/^evb-shape:/);
        expect(created?.strokes?.[0]).toHaveLength(3);
        // The draft is not canonical until its creator commits it.
        expect(projection.shapes.getAllShapes()).toEqual([]);
        expect(projection.shapes.hasShapes.value).toBe(false);

        projection.application.value.createShapeFromGeometry(created!);

        expect(projection.shapes.selectedShapeId.value).toBeNull();
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('timestamps created drawings and updates their modified time on canonical edits', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-25T10:00:00Z'));

        try {
            const projection = createShapeProjection();
            projection.shapes.startDrawing(0, 'rectangle', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);

            vi.setSystemTime(new Date('2026-05-25T10:01:00Z'));
            projection.shapes.continueDrawing(0.3, 0.4);
            const created = projection.shapes.finishDrawing();

            expect(created?.createdAt).toBe(new Date('2026-05-25T10:00:00Z').getTime());
            expect(created?.modifiedAt).toBe(new Date('2026-05-25T10:01:00Z').getTime());
            projection.application.value.createShapeFromGeometry(created!);

            vi.setSystemTime(new Date('2026-05-25T10:02:00Z'));
            const entity = projection.application.value.store.listShapes()[0]!;
            projection.application.value.replaceShapeGeometry(entity.identity.id, {
                ...entity.geometry,
                color: '#ff0000',
                modifiedAt: Date.now(),
            });

            const updated = projection.shapes.getShapeById(created!.id);
            expect(updated?.createdAt).toBe(created?.createdAt);
            expect(updated?.modifiedAt).toBe(new Date('2026-05-25T10:02:00Z').getTime());
        } finally {
            vi.useRealTimers();
        }
    });

    it('reconciles a freshly saved local draw stroke onto the imported embedded shape without changing its id', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            stableKey: created.stableKey,
            x: created.x,
            y: created.y,
            width: created.width,
            height: created.height,
            color: created.color,
            opacity: created.opacity,
            strokeWidth: created.strokeWidth,
            points: created.points,
            strokes: created.strokes,
        });

        const plan = projection.shapes.importEmbeddedShapes([importedEmbeddedInkShape], IMPORT_SOURCE);

        expect(plan.mode).toBe('reconcile');
        expect(projection.shapes.getShapeById(created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '21R',
            stableKey: created.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('primes saved shape metadata without replacing the live geometry or clearing dirty state', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);
        expect(projection.shapes.hasShapes.value).toBe(true);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            annotationId: '99R',
            stableKey: created.stableKey,
            x: created.x + 0.02,
            y: created.y + 0.03,
            points: created.points?.map(point => ({
                x: point.x + 0.02,
                y: point.y + 0.03,
            })),
            strokes: created.strokes?.map(stroke => stroke.map(point => ({
                x: point.x + 0.02,
                y: point.y + 0.03,
            }))),
        });

        const preparation = projection.shapes.beginShapeSave();
        preparation.primePersistedShapes([importedEmbeddedInkShape]);

        expect(projection.shapes.getShapeById(created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '99R',
            stableKey: created.stableKey,
            x: created.x,
            y: created.y,
        });
        expect(projection.application.value.store.listShapes()[0]).toMatchObject({
            identity: {pdfRef: '99R'},
            geometry: {source: 'local'},
        });
        expect(projection.shapes.getShapeById(created.id)?.points).toEqual(created.points);
        expect(projection.shapes.hasShapes.value).toBe(true);

        projection.shapes.markSavedShapeState();

        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('primes persisted identities without invalidating a captured save frontier', () => {
        const projection = createShapeProjection();
        const survivingEmbeddedShape = createEmbeddedShape();
        projection.shapes.importEmbeddedShapes([survivingEmbeddedShape], IMPORT_SOURCE);
        const created = drawLocalShape(projection);

        const preparation = projection.shapes.beginShapeSave();
        const frontier = projection.store.beginSave();
        // The scan carries only the drawn shape, so the embedded one is unmatched.
        preparation.primePersistedShapes([createEmbeddedInkShape({
            annotationId: '77R',
            stableKey: created.stableKey,
        })]);

        // Identity reconciliation is permitted after the frontier is captured;
        // priming may neither mutate nor drop a captured entity.
        expect(() => projection.store.assertSaveFrontierCurrent(frontier)).not.toThrow();
        const createdId = projection.application.value.annotationIdForShape(created);
        expect(projection.store.get(createdId!)?.identity.pdfRef).toBe('77R');
        expect(projection.shapes.getShapeById(survivingEmbeddedShape.id)).not.toBeNull();

        const entity = projection.application.value.store.listShapes()[0]!;
        projection.application.value.replaceShapeGeometry(entity.identity.id, {
            ...entity.geometry,
            color: '#ff0000',
        });

        expect(() => projection.store.assertSaveFrontierCurrent(frontier))
            .toThrow(/staleRevisionError/u);
    });

    it('rolls a primed save back through the store frontier when the persist fails', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        const preparation = projection.shapes.beginShapeSave();
        preparation.primePersistedShapes([createEmbeddedInkShape({stableKey: created.stableKey})]);
        const createdId = projection.application.value.annotationIdForShape(created);
        expect(projection.store.get(createdId!)?.identity.pdfRef).toBe('21R');

        expect(preparation.rollback()).toBe(true);

        expect(projection.shapes.getShapeById(created.id)).toMatchObject({
            id: created.id,
            source: 'local',
            stableKey: created.stableKey,
        });
        expect(projection.store.get(createdId!)?.identity.pdfRef).toBeUndefined();
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('adopts self-saved shape metadata as clean without replacing visible geometry', () => {
        const projection = createShapeProjection();
        projection.shapes.importEmbeddedShapes([], IMPORT_SOURCE);
        const created = drawLocalShape(projection);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            annotationId: '88R',
            stableKey: created.stableKey,
            x: created.x + 0.02,
            y: created.y + 0.03,
        });

        projection.application.value.store.adoptPersistedShapesOnNextImport();
        const plan = projection.shapes.importEmbeddedShapes([importedEmbeddedInkShape], IMPORT_SOURCE);

        expect(plan.mode).toBe('adopt-self-saved');
        expect(plan.skipRerender).toBe(true);
        expect(projection.shapes.getShapeById(created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '88R',
            stableKey: created.stableKey,
            x: created.x,
            y: created.y,
        });
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('adopts saved shape deletions as clean persisted state', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape();

        projection.shapes.importEmbeddedShapes([embeddedInkShape], IMPORT_SOURCE);
        deleteShape(projection, embeddedInkShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(projection.shapes.hasShapes.value).toBe(true);

        projection.application.value.store.adoptPersistedShapesOnNextImport();
        projection.shapes.importEmbeddedShapes([], IMPORT_SOURCE);

        expect(projection.shapes.getAllShapes()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('reconciles a persisted drawing by stable key when the saved annotation ref changes', () => {
        const projection = createShapeProjection();
        const created = drawLocalShape(projection);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            annotationId: '44R',
            stableKey: created.stableKey,
            x: created.x + 0.0002,
            y: created.y + 0.00015,
            points: created.points?.map(point => ({
                x: point.x + 0.0002,
                y: point.y + 0.00015,
            })),
            strokes: created.strokes?.map(stroke => stroke.map(point => ({
                x: point.x + 0.0002,
                y: point.y + 0.00015,
            }))),
        });

        projection.shapes.importEmbeddedShapes([importedEmbeddedInkShape], IMPORT_SOURCE);

        expect(projection.shapes.getShapeById(created.id)).toMatchObject({
            id: created.id,
            source: 'embedded',
            annotationId: '44R',
            stableKey: created.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(projection.shapes.getShapeById(created.id)?.points).toEqual(importedEmbeddedInkShape.points);
        expect(projection.shapes.getShapeById(created.id)?.x).toBe(importedEmbeddedInkShape.x);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('uses the imported managed shape geometry as the saved baseline after same-file reconciliation', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape({
            id: 'shape-current-ink',
            stableKey: 'evb-shape:current-ink',
            annotationId: '21R',
        });

        projection.shapes.importEmbeddedShapes([embeddedInkShape], IMPORT_SOURCE);

        const importedEmbeddedInkShape = createEmbeddedInkShape({
            id: 'shape-imported-ink',
            stableKey: embeddedInkShape.stableKey,
            annotationId: '44R',
            x: embeddedInkShape.x + 0.012,
            y: embeddedInkShape.y + 0.015,
            strokeWidth: embeddedInkShape.strokeWidth + 2,
            opacity: 0.5,
        });

        projection.shapes.importEmbeddedShapes([importedEmbeddedInkShape], IMPORT_SOURCE);

        expect(projection.shapes.getShapeById(embeddedInkShape.id)).toEqual({
            ...importedEmbeddedInkShape,
            id: embeddedInkShape.id,
            source: 'embedded',
            annotationId: '44R',
            stableKey: embeddedInkShape.stableKey,
            pdfSubtype: 'Ink',
        });
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('keeps unmatched local shapes dirty when a late same-file import reconciles saved embedded shapes', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape({
            id: 'shape-saved-ink',
            stableKey: 'evb-shape:saved-ink',
            annotationId: '41R',
        });

        projection.shapes.importEmbeddedShapes([embeddedInkShape], IMPORT_SOURCE);
        const localShape = drawLocalShape(projection);

        projection.shapes.importEmbeddedShapes([createEmbeddedInkShape({
            ...embeddedInkShape,
            annotationId: '52R',
            x: embeddedInkShape.x + 0.01,
            y: embeddedInkShape.y + 0.01,
        })], IMPORT_SOURCE);

        expect(projection.shapes.getShapeById(embeddedInkShape.id)).toMatchObject({
            id: embeddedInkShape.id,
            source: 'embedded',
            annotationId: '52R',
            stableKey: embeddedInkShape.stableKey,
        });
        expect(projection.shapes.getShapeById(localShape.id)).toMatchObject({
            id: localShape.id,
            source: 'local',
        });
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('keeps deleted embedded shape tombstones until the imported document no longer contains them', () => {
        const projection = createShapeProjection();
        const embeddedInkShape = createEmbeddedInkShape();

        projection.shapes.importEmbeddedShapes([embeddedInkShape], IMPORT_SOURCE);
        deleteShape(projection, embeddedInkShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.hasShapes.value).toBe(true);

        projection.shapes.importEmbeddedShapes([embeddedInkShape], IMPORT_SOURCE);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual(['evb-shape:embedded-ink-1']);
        expect(projection.shapes.hasShapes.value).toBe(true);

        projection.shapes.importEmbeddedShapes([], IMPORT_SOURCE);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('does not resurrect a just-deleted embedded shape when a stale import finishes after the delete', () => {
        const projection = createShapeProjection();
        const firstEmbeddedInkShape = createEmbeddedInkShape();
        const secondEmbeddedInkShape = createEmbeddedInkShape({
            id: 'embedded-ink-2',
            annotationId: '22R',
            stableKey: 'evb-shape:embedded-ink-2',
            color: '#22c55e',
            x: 0.4,
            y: 0.28,
        });

        projection.shapes.importEmbeddedShapes([
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ], IMPORT_SOURCE);
        deleteShape(projection, secondEmbeddedInkShape.id);

        projection.shapes.importEmbeddedShapes([
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ], IMPORT_SOURCE);

        expect(projection.shapes.getAllShapes()).toHaveLength(1);
        expect(projection.shapes.getAllShapes()[0]).toMatchObject({
            id: firstEmbeddedInkShape.id,
            annotationId: firstEmbeddedInkShape.annotationId,
        });
        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['22R']);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('marks the current shapes as the saved baseline and clears deleted embedded tombstones', () => {
        const projection = createShapeProjection();
        const firstEmbeddedInkShape = createEmbeddedInkShape();
        const secondEmbeddedInkShape = createEmbeddedInkShape({
            id: 'embedded-ink-2',
            annotationId: '22R',
            stableKey: 'evb-shape:embedded-ink-2',
            color: '#22c55e',
            x: 0.4,
            y: 0.28,
        });

        projection.shapes.importEmbeddedShapes([
            firstEmbeddedInkShape,
            secondEmbeddedInkShape,
        ], IMPORT_SOURCE);
        deleteShape(projection, firstEmbeddedInkShape.id);

        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual(['21R']);
        expect(projection.shapes.hasShapes.value).toBe(true);

        projection.shapes.markSavedShapeState();

        expect(projection.shapes.getAllShapes()).toEqual([secondEmbeddedInkShape]);
        expect(projection.shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(projection.shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('refuses a prepared clean mark once another document owns the projection', () => {
        const projection = createShapeProjection();
        drawLocalShape(projection);
        const preparation = projection.shapes.beginShapeSave();

        // The save primed the previous document; the viewer has since adopted
        // another one, whose shapes this save says nothing about.
        projection.application.value = new AnnotationApplication('other-doc-key');
        drawLocalShape(projection);

        expect(projection.shapes.markSavedShapeState(preparation)).toBe(false);
        expect(projection.shapes.hasShapes.value).toBe(true);
    });

    it('marks the live store clean through the token the save primed', () => {
        const projection = createShapeProjection();
        drawLocalShape(projection);
        const preparation = projection.shapes.beginShapeSave();

        expect(projection.shapes.markSavedShapeState(preparation)).toBe(true);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('marks the live store clean when a save had nothing to prime', () => {
        const projection = createShapeProjection();
        drawLocalShape(projection);

        expect(projection.shapes.markSavedShapeState()).toBe(true);
        expect(projection.shapes.hasShapes.value).toBe(false);
    });

    it('replaces the projection when the authority is swapped for another document', () => {
        const projection = createShapeProjection();
        projection.shapes.importEmbeddedShapes([createEmbeddedShape()], IMPORT_SOURCE);
        expect(projection.shapes.getAllShapes()).toHaveLength(1);

        projection.application.value = new AnnotationApplication('other-doc-key');

        expect(projection.shapes.getAllShapes()).toEqual([]);
        expect(projection.shapes.isShapeImportBaselineReady()).toBe(false);
    });
});
