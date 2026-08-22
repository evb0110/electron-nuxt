import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {IAnnotationHistoryAuthority} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {IPdfAppAnnotationHistoryCommand} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {ExternalIdentityConflictError} from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {AnnotationHistoryCompensationError} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {
    asAnnotationId,
    type IStickyNoteEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

function stickyNote(id: string, pdfjsUid: string): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId(id),
            pdfjsUid,
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

function textMarkup(id: string, pdfjsUid: string): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: {
            id: asAnnotationId(id),
            pdfjsUid,
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        subtype: 'Highlight',
        text: '',
        geometry: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }],
        color: '#ffff00',
        opacity: 1,
    };
}

describe('AnnotationStore external identity history', () => {
    it('releases a created annotation identity on undo and restores it on redo', () => {
        const store = new AnnotationStore();
        const note = stickyNote('original-note', 'editor-1');

        store.createStickyNote(note);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBe(note.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBe(note.identity.id);
    });

    it('rolls back a canonical undo that throws after mutating and keeps it retryable', () => {
        const store = new AnnotationStore();
        const note = stickyNote('retryable-note', 'retryable-editor');
        const replayFailure = new Error('projection listener failed');
        store.createStickyNote(note);
        let failNextEmission = false;
        store.subscribe(() => {
            if (!failNextEmission) {
                return;
            }
            failNextEmission = false;
            throw replayFailure;
        });

        failNextEmission = true;
        let received: unknown;
        try {
            store.undo();
        } catch (error) {
            received = error;
        }

        expect(received).toBe(replayFailure);
        expect(store.get(note.identity.id)).toEqual(note);
        expect(store.resolveExternal({pdfjsUid: 'retryable-editor'})).toBe(note.identity.id);
        expect(store.canUndo).toBe(true);
        expect(store.canRedo).toBe(false);

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toBeNull();
        expect(store.resolveExternal({pdfjsUid: 'retryable-editor'})).toBeNull();
        expect(store.canRedo).toBe(true);
    });

    it('clears canonical history and reports every failed rollback after an undo emission fails', () => {
        const store = new AnnotationStore();
        const note = stickyNote('poisoned-note', 'poisoned-editor');
        const replayFailure = new Error('projection listener failed');
        const rollbackFailure = new Error('rollback projection listener failed');
        const failures: Error[] = [];
        store.createStickyNote(note);
        store.subscribe(() => {
            const failure = failures.shift();
            if (failure) throw failure;
        });
        failures.push(replayFailure, rollbackFailure);

        let received: unknown;
        try {
            store.undo();
        } catch (error) {
            received = error;
        }

        expect(received).toBeInstanceOf(AnnotationHistoryCompensationError);
        expect((received as AnnotationHistoryCompensationError).cause).toBe(replayFailure);
        expect((received as AnnotationHistoryCompensationError).rollbackErrors).toEqual([rollbackFailure]);
        expect(store.get(note.identity.id)).toEqual(note);
        expect(store.resolveExternal({pdfjsUid: 'poisoned-editor'})).toBe(note.identity.id);
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
    });

    it('lets a deleted identity be recreated and follows both entities through history', () => {
        const store = new AnnotationStore();
        const original = stickyNote('original-note', 'editor-1');
        const recreated = stickyNote('recreated-note', 'editor-1');
        store.createStickyNote(original);

        store.delete(original.identity.id);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBeNull();

        expect(() => store.createStickyNote(recreated)).not.toThrow();
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBe(recreated.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBeNull();
        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBe(original.identity.id);

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBeNull();
        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-1'})).toBe(recreated.identity.id);
    });

    it('updates the identity index with a batched markup selection through undo and redo', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('created-markup', 'editor-markup');

        store.applyTextMarkupSelection(markup, []);
        expect(store.resolveExternal({pdfjsUid: 'editor-markup'})).toBe(markup.identity.id);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-markup'})).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'editor-markup'})).toBe(markup.identity.id);
    });

    it('keeps saved-baseline semantics independent from live identity bindings', () => {
        const store = new AnnotationStore();
        const note = stickyNote('saved-note', 'saved-editor');
        store.createStickyNote(note);
        store.acknowledgeSave(store.beginSave());
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);

        store.delete(note.identity.id);
        expect(store.resolveExternal({pdfjsUid: 'saved-editor'})).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);

        store.acknowledgeSave(store.beginSave());
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'saved-editor'})).toBe(note.identity.id);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('tracks live state when imports tombstone and restore an entity', () => {
        const store = new AnnotationStore();
        const note = {
            ...stickyNote('imported-note', 'imported-editor'),
            persistedRevision: 0,
        };
        store.import(note);
        expect(store.resolveExternal({pdfjsUid: 'imported-editor'})).toBe(note.identity.id);

        store.import({
            ...note,
            revision: 1,
            deleted: true,
        }, {preserveSavedBaseline: true});
        expect(store.resolveExternal({pdfjsUid: 'imported-editor'})).toBeNull();

        store.import({
            ...note,
            revision: 2,
            deleted: false,
        }, {preserveSavedBaseline: true});
        expect(store.resolveExternal({pdfjsUid: 'imported-editor'})).toBe(note.identity.id);
    });

    it('does not resurrect a deleted binding while forgetting another entity', () => {
        const store = new AnnotationStore();
        const deleted = stickyNote('deleted-note', 'deleted-editor');
        const forgotten = stickyNote('forgotten-note', 'forgotten-editor');
        store.createStickyNote(deleted);
        store.delete(deleted.identity.id);
        store.createStickyNote(forgotten);

        store.forget(new Set([forgotten.identity.id]));

        expect(store.resolveExternal({pdfjsUid: 'deleted-editor'})).toBeNull();
        expect(store.resolveExternal({pdfjsUid: 'forgotten-editor'})).toBeNull();
    });

    it('prunes history that could recreate a hard-forgotten entity', () => {
        const store = new AnnotationStore();
        const note = stickyNote('forgotten-created-note', 'forgotten-created-editor');
        store.createStickyNote(note);
        store.forget(new Set([note.identity.id]));

        expect(store.get(note.identity.id)).toBeNull();
        expect(store.resolveExternal({pdfjsUid: 'forgotten-created-editor'})).toBeNull();
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
        expect(store.undo()).toBe(false);
        expect(store.redo()).toBe(false);
    });

    it('uses the explicit id if an external authority replays a stale null-to-null command', () => {
        let command: IPdfAppAnnotationHistoryCommand | null = null;
        const history: IAnnotationHistoryAuthority = {
            get canUndo() { return command !== null; },
            get canRedo() { return false; },
            registerCommand(registered) { command = registered; },
            forgetCommands() {},
            undo() {
                if (!command) {
                    return false;
                }
                command.undo();
                return true;
            },
            redo: () => false,
        };
        const store = new AnnotationStore(history);
        const note = stickyNote('stale-forgotten-note', 'stale-forgotten-editor');
        store.createStickyNote(note);
        store.forget(new Set([note.identity.id]));

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toBeNull();
        expect(store.resolveExternal({pdfjsUid: 'stale-forgotten-editor'})).toBeNull();
    });

    it('releases the binding when a page remap tombstones an annotation', () => {
        const store = new AnnotationStore();
        const note = stickyNote('removed-page-note', 'removed-page-editor');
        store.createStickyNote(note);

        store.remapPages({
            previousPageCount: 1,
            pages: [],
        });

        expect(store.resolveExternal({pdfjsUid: 'removed-page-editor'})).toBeNull();
    });

    it('records new identity metadata on a tombstone without publishing a live binding', () => {
        const store = new AnnotationStore();
        const note = stickyNote('deleted-note', 'deleted-editor');
        store.createStickyNote(note);
        store.delete(note.identity.id);

        store.bindIdentity({
            annotationId: note.identity.id,
            expectedRevision: 1,
            bindings: {elementId: 'deleted-element'},
        });

        expect(store.get(note.identity.id)?.identity.elementId).toBe('deleted-element');
        expect(store.resolveExternal({pdfjsUid: 'deleted-editor'})).toBeNull();
        expect(store.resolveExternal({elementId: 'deleted-element'})).toBeNull();
    });

    it('does not publish a materialized ref when acknowledging a saved tombstone', () => {
        const store = new AnnotationStore();
        const note = stickyNote('deleted-note', 'deleted-editor');
        store.createStickyNote(note);
        store.delete(note.identity.id);
        const frontier = store.beginSave();

        store.acknowledgeSave(frontier, new Map([[
            note.identity.id,
            '12R',
        ]]));

        expect(store.get(note.identity.id)?.identity.pdfRef).toBe('12R');
        expect(store.resolveExternal({pdfRef: '12R'})).toBeNull();
    });

    it('atomically swaps materialized refs while acknowledging a save', () => {
        const store = new AnnotationStore();
        const first = {
            ...stickyNote('first-note', 'first-editor'),
            identity: {
                id: asAnnotationId('first-note'),
                pdfRef: '1R',
            },
        };
        const second = {
            ...stickyNote('second-note', 'second-editor'),
            identity: {
                id: asAnnotationId('second-note'),
                pdfRef: '2R',
            },
        };
        store.createStickyNote(first);
        store.createStickyNote(second);

        store.acknowledgeSave(store.beginSave(), new Map([
            [
                first.identity.id,
                '2R',
            ],
            [
                second.identity.id,
                '1R',
            ],
        ]));

        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '2R'},
            persistedRevision: 0,
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '1R'},
            persistedRevision: 0,
        });
        expect(store.resolveExternal({pdfRef: '2R'})).toBe(first.identity.id);
        expect(store.resolveExternal({pdfRef: '1R'})).toBe(second.identity.id);
    });

    it('rolls back every save acknowledgement update when one ref conflicts', () => {
        const store = new AnnotationStore();
        const first = {
            ...stickyNote('first-note', 'first-editor'),
            identity: {
                id: asAnnotationId('first-note'),
                pdfRef: '1R',
            },
        };
        const second = {
            ...stickyNote('second-note', 'second-editor'),
            identity: {
                id: asAnnotationId('second-note'),
                pdfRef: '2R',
            },
        };
        const owner = {
            ...stickyNote('owner-note', 'owner-editor'),
            identity: {
                id: asAnnotationId('owner-note'),
                pdfRef: 'occupied-ref',
            },
        };
        store.createStickyNote(first);
        store.createStickyNote(second);
        store.createStickyNote(owner);
        const frontier = store.beginSave();

        expect(() => store.acknowledgeSave(frontier, new Map([
            [
                first.identity.id,
                'new-first-ref',
            ],
            [
                second.identity.id,
                'occupied-ref',
            ],
        ]))).toThrow(ExternalIdentityConflictError);

        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '1R'},
            persistedRevision: -1,
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '2R'},
            persistedRevision: -1,
        });
        expect(store.get(owner.identity.id)?.persistedRevision).toBe(-1);
        expect(store.resolveExternal({pdfRef: 'new-first-ref'})).toBeNull();
        expect(store.resolveExternal({pdfRef: '1R'})).toBe(first.identity.id);
        expect(store.resolveExternal({pdfRef: '2R'})).toBe(second.identity.id);
        expect(store.resolveExternal({pdfRef: 'occupied-ref'})).toBe(owner.identity.id);
    });

    it('rejects a conflicting redo before changing the live entity or its binding', () => {
        const store = new AnnotationStore();
        const original = stickyNote('original-note', 'shared-editor');
        const competing = {
            ...stickyNote('competing-note', 'shared-editor'),
            persistedRevision: 0,
        };
        store.createStickyNote(original);
        store.undo();
        store.import(competing);

        expect(() => store.redo()).toThrow(ExternalIdentityConflictError);
        expect(store.get(original.identity.id)).toBeNull();
        expect(store.resolveExternal({pdfjsUid: 'shared-editor'})).toBe(competing.identity.id);
        expect(store.canRedo).toBe(true);

        store.forget(new Set([competing.identity.id]));
        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfjsUid: 'shared-editor'})).toBe(original.identity.id);
    });
});
