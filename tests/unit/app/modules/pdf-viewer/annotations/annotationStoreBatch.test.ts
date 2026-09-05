import {
    describe,
    expect,
    it,
} from 'vitest';
import { AnnotationStore } from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    asAnnotationId,
    type IStickyNoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function note(id: string): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        text: id,
        anchor: {
            left: 0.2,
            top: 0.3,
            width: 0.01,
            height: 0.01,
        },
        color: null,
    };
}

describe('AnnotationStore batched notifications', () => {
    it('publishes nested mutations together while preserving individual undo commands', () => {
        const store = new AnnotationStore();
        const snapshots: string[][] = [];
        store.subscribe(entities => snapshots.push(entities.map(entity => entity.identity.id)));

        store.batch(() => {
            store.createStickyNote(note('first'));
            store.batch(() => store.createStickyNote(note('second')));
            expect(snapshots).toEqual([[]]);
        });

        expect(snapshots).toEqual([
            [],
            [
                'first',
                'second',
            ],
        ]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.undo()).toBe(true);
        expect(snapshots.at(-1)).toEqual(['first']);
        expect(store.undo()).toBe(true);
        expect(snapshots.at(-1)).toEqual([]);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.redo()).toBe(true);
        expect(snapshots.at(-1)).toEqual(['first']);
    });

    it('publishes completed mutations after a callback throws and resumes normal notifications', () => {
        const store = new AnnotationStore();
        const snapshots: string[][] = [];
        store.subscribe(entities => snapshots.push(entities.map(entity => entity.identity.id)));

        expect(() => store.batch(() => {
            store.createStickyNote(note('before-error'));
            throw new Error('import interrupted');
        })).toThrow('import interrupted');

        expect(snapshots).toEqual([
            [],
            ['before-error'],
        ]);
        store.createStickyNote(note('after-error'));
        expect(snapshots).toEqual([
            [],
            ['before-error'],
            [
                'before-error',
                'after-error',
            ],
        ]);
    });
});
