import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {
    IShapeEntity,
    IStickyNoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function stickyNote(
    id: string,
    identity: Partial<IStickyNoteEntity['identity']> = {},
): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId(id),
            ...identity,
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        text: '',
        anchor: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
    };
}

function shape(id: string): IShapeEntity {
    return {
        kind: 'shape',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        geometry: {
            id,
            type: 'rectangle',
            pageIndex: 0,
            x: 0.1,
            y: 0.1,
            width: 0.2,
            height: 0.2,
            color: '#ff0000',
            strokeWidth: 2,
            opacity: 1,
            source: 'local',
        },
    };
}

describe('AnnotationStore editor presence reconciliation', () => {
    it('tombstones a transient the editor layer never bound an external id to', () => {
        const store = new AnnotationStore();
        const orphan = stickyNote('unbound-note');
        store.createStickyNote(orphan);

        store.reconcileEditorPresence(new Set());

        expect(store.get(orphan.identity.id)).toMatchObject({
            deleted: true,
            revision: 1,
        });
        expect(store.list()).toEqual([]);
    });

    it('tombstones a transient whose bound editor is gone from the snapshot', () => {
        const store = new AnnotationStore();
        const bound = stickyNote('bound-note', {
            pdfjsUid: 'editor-7',
            elementId: 'element-7',
        });
        store.createStickyNote(bound);

        store.reconcileEditorPresence(new Set(['editor-9']));

        expect(store.get(bound.identity.id)?.deleted).toBe(true);
    });

    it('keeps a transient whose editor is still present', () => {
        const store = new AnnotationStore();
        const bound = stickyNote('present-note', {pdfjsUid: 'editor-7'});
        store.createStickyNote(bound);

        store.reconcileEditorPresence(new Set(['editor-7']));

        expect(store.get(bound.identity.id)).toMatchObject({
            deleted: false,
            revision: 0,
        });
    });

    it('leaves a persisted annotation alone when its editor is absent', () => {
        const store = new AnnotationStore();
        const persisted = {
            ...stickyNote('persisted-note', {pdfRef: '12R'}),
            persistedRevision: 0,
        };
        store.import(persisted);

        store.reconcileEditorPresence(new Set());

        expect(store.get(persisted.identity.id)).toMatchObject({
            deleted: false,
            revision: 0,
        });
    });

    it('restores a tombstoned annotation the editor layer still renders', () => {
        const store = new AnnotationStore();
        const persisted = {
            ...stickyNote('restored-note', {elementId: 'element-3'}),
            persistedRevision: 0,
        };
        store.import(persisted);
        store.delete(persisted.identity.id);

        store.reconcileEditorPresence(new Set(['element-3']));

        expect(store.get(persisted.identity.id)).toMatchObject({deleted: false});
        expect(store.resolveExternal({elementId: 'element-3'})).toBe(persisted.identity.id);
    });

    it('never judges a shape by editor presence', () => {
        const store = new AnnotationStore();
        const drawn = shape('drawn-shape');
        store.createShape(drawn);

        store.reconcileEditorPresence(new Set());

        expect(store.get(drawn.identity.id)?.deleted).toBe(false);
    });

    it('does not create an undo step for a presence decision', () => {
        const store = new AnnotationStore();
        const orphan = stickyNote('history-free-note');
        store.createStickyNote(orphan);

        store.reconcileEditorPresence(new Set());

        expect(store.undo()).toBe(true);
        expect(store.get(orphan.identity.id)).toBeNull();
        expect(store.canUndo).toBe(false);
    });

    it('does not tombstone a saved annotation a redo brought back', () => {
        const store = new AnnotationStore();
        const note = stickyNote('redone-note', {pdfjsUid: 'editor-1'});
        store.createStickyNote(note);
        store.acknowledgeSave(store.beginSave(), new Map([[
            note.identity.id,
            '21R',
        ]]));
        expect(store.undo()).toBe(true);
        expect(store.redo()).toBe(true);

        store.reconcileEditorPresence(new Set());

        expect(store.get(note.identity.id)).toMatchObject({
            deleted: false,
            identity: {pdfRef: '21R'},
            persistedRevision: 0,
        });
    });
});
