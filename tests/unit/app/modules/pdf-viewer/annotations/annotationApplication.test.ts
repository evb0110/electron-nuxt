import {
    describe,
    expect,
    it,
} from 'vitest';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type IStickyNoteEntity,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import type { IShapeAnnotation } from '@app/types/annotations';

function note(overrides: Partial<IStickyNoteEntity> = {}): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId('anno_test'),
            pdfName: 'evb:anno_test',
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Tester',
        text: 'original',
        anchor: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
        ...overrides,
    };
}

function shape(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: 'shape-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        color: '#336699',
        fillColor: undefined,
        opacity: 1,
        strokeWidth: 2,
        source: 'local',
        ...overrides,
    };
}

describe('AnnotationApplication', () => {
    it('rejects a save when an edit advances the global frontier during verification', async () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note());
        const session = application.beginSave();
        application.setNoteText(asAnnotationId('anno_test'), 'newer');

        await expect(application.verifyAndAcknowledgeSave(
            session,
            new Uint8Array([1]),
            {reopen: async () => [note()]},
        )).rejects.toThrow('staleRevisionError');

        const current = application.store.get(asAnnotationId('anno_test'));
        expect(current).toMatchObject({
            revision: 1,
            persistedRevision: -1,
            text: 'newer',
        });
        expect(application.beginSave().plan.expected).toMatchObject([{
            revision: 1,
            text: 'newer',
        }]);
    });

    it('normalizes adapter-only liveness sentinels and preserves tombstones through history', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note());
        application.setNoteText(asAnnotationId('anno_test'), '\u200Bhello\uFEFF');
        application.delete(asAnnotationId('anno_test'));
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({
            deleted: true,
            text: 'hello',
        });
        expect(application.undo()).toBe(true);
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({
            deleted: false,
            text: 'hello',
        });
        expect(application.redo()).toBe(true);
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({deleted: true});
    });

    it('rejects reopen results with stale text or geometry', async () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note());
        const session = application.beginSave();
        await expect(application.verifyAndAcknowledgeSave(session, new Uint8Array([1]), {reopen: async () => [note({text: 'stale'})]})).rejects.toThrow('text mismatch');
    });

    it('rolls canonical shape creation back when the projection executor fails', () => {
        const application = new AnnotationApplication('document');

        expect(() => application.createShapeProjected({
            kind: 'shape',
            pageIndex: 0,
            createdAt: 1,
            modifiedAt: 1,
            author: null,
            geometry: shape(),
        }, () => {
            throw new Error('projection failed');
        })).toThrow('projection failed');

        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(application.store.canUndo).toBe(false);
    });

    it('projects shape undo and redo from the single canonical history command', () => {
        const application = new AnnotationApplication('document');
        const projected: IShapeAnnotation[] = [];
        const applyProjection = (next: {geometry: Readonly<IShapeAnnotation>} | null) => {
            projected.splice(0, projected.length, ...(next ? [structuredClone(next.geometry)] : []));
        };

        application.createShapeProjected({
            kind: 'shape',
            pageIndex: 0,
            createdAt: 1,
            modifiedAt: 1,
            author: null,
            geometry: shape(),
        }, applyProjection);
        const annotationId = application.annotationIdForShape(shape());

        expect(annotationId).not.toBeNull();
        expect(projected).toHaveLength(1);
        expect(application.undo()).toBe(true);
        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(projected).toEqual([]);
        expect(application.redo()).toBe(true);
        expect(application.store.get(annotationId!)).toMatchObject({kind: 'shape'});
        expect(projected).toHaveLength(1);
    });

    it('remaps surviving annotation and shape identities through a page-tree delta', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note({pageIndex: 0}));
        application.createShapeProjected({
            kind: 'shape',
            pageIndex: 2,
            createdAt: 1,
            modifiedAt: 1,
            author: null,
            geometry: shape({pageIndex: 2}),
        }, () => undefined);
        const shapeId = application.annotationIdForShape(shape({pageIndex: 2}));

        application.remapPages({
            previousPageCount: 3,
            pages: [
                {fromPageNumber: 3},
                {fromPageNumber: 2},
            ],
        });

        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({deleted: true});
        expect(application.store.get(shapeId!)).toMatchObject({
            pageIndex: 0,
            geometry: {pageIndex: 0},
        });
    });
});
