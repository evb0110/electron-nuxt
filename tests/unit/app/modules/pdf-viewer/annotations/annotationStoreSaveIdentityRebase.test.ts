import {
    describe,
    expect,
    it,
} from 'vitest';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import type {IAnnotationHistoryAuthority} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import type {
    AnnotationId,
    IShapeEntity,
    IStickyNoteEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IPdfAppAnnotationHistoryCommand} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {LocalAnnotationHistoryAuthority} from '@app/modules/pdf-viewer/engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {estimateRetainedAnnotationBytes} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/estimateAnnotationSnapshotBytes';

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

function persistedShape(id: string, pdfRef: string, x: number): IShapeEntity {
    return {
        kind: 'shape',
        identity: {
            id: asAnnotationId(id),
            pdfRef,
            elementId: id,
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: null,
        geometry: {
            id,
            type: 'rectangle',
            pageIndex: 0,
            x,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            color: '#123456',
            opacity: 1,
            strokeWidth: 2,
            source: 'embedded',
            stableKey: `evb-shape:${id}`,
            annotationId: pdfRef,
        },
    };
}

/** Records the commands the store registers so retained-size claims stay checkable. */
function createRecordingHistoryAuthority() {
    const local = new LocalAnnotationHistoryAuthority();
    const commands: IPdfAppAnnotationHistoryCommand[] = [];
    const authority: IAnnotationHistoryAuthority = {
        get canUndo() { return local.canUndo; },
        get canRedo() { return local.canRedo; },
        registerCommand: (command) => {
            commands.push(command);
            local.registerCommand(command);
        },
        forgetCommands: ids => local.forgetCommands(ids),
        undo: () => local.undo(),
        redo: () => local.redo(),
    };
    return {
        authority,
        commands,
    };
}

function saveWithMaterializedRef(store: AnnotationStore, id: AnnotationId, pdfRef: string) {
    store.acknowledgeSave(store.beginSave(), new Map([[
        id,
        pdfRef,
    ]]));
}

describe('AnnotationStore save identity rebase', () => {
    it('keeps the acknowledged persistence identity through undo and redo of an edit', () => {
        const store = new AnnotationStore();
        const note = stickyNote('edited-note', 'edited-editor');
        store.createStickyNote(note);
        store.setNoteText(note.identity.id, 'saved text');

        saveWithMaterializedRef(store, note.identity.id, '12R');

        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            text: 'saved text',
        });

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            text: '',
        });

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            text: 'saved text',
        });
        expect(store.resolveExternal({pdfRef: '12R'})).toBe(note.identity.id);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('restores the acknowledged persistence identity when redoing a saved create', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('saved-markup', 'markup-editor');
        store.createTextMarkup(markup);

        saveWithMaterializedRef(store, markup.identity.id, '31R');

        expect(store.undo()).toBe(true);
        expect(store.get(markup.identity.id)).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({
            identity: {pdfRef: '31R'},
            persistedRevision: 0,
        });
        expect(store.resolveExternal({pdfRef: '31R'})).toBe(markup.identity.id);
        // The saved file still holds the annotation, so the redone entity is
        // not a dirty transient the next save has to write again.
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.dirtyAt(store.beginSave())).toEqual([]);
    });

    it('keeps a redo entry captured before the acknowledgement on the saved identity', () => {
        const store = new AnnotationStore();
        const note = stickyNote('cursor-note', 'cursor-editor');
        store.createStickyNote(note);
        store.setNoteText(note.identity.id, 'first');
        store.setNoteText(note.identity.id, 'second');

        expect(store.undo()).toBe(true);
        saveWithMaterializedRef(store, note.identity.id, '44R');

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '44R'},
            persistedRevision: 1,
            text: 'second',
        });
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('keeps the persisted identity on both sides of an acknowledged delete', () => {
        const store = new AnnotationStore();
        const note = {
            ...stickyNote('deleted-note', 'deleted-editor'),
            identity: {
                id: asAnnotationId('deleted-note'),
                pdfjsUid: 'deleted-editor',
                pdfRef: '9R',
            },
            persistedRevision: 0,
        };
        store.import(note);
        store.delete(note.identity.id);
        store.acknowledgeSave(store.beginSave());

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            deleted: false,
            identity: {pdfRef: '9R'},
            persistedRevision: 1,
        });

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '9R'},
            persistedRevision: 1,
        });
        expect(store.countDirtyPersistedDeletions()).toBe(0);
    });

    it('rebases every annotation in a batched markup selection', () => {
        const store = new AnnotationStore();
        const geometry = [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }];
        const existing: ITextMarkupEntity = {
            ...textMarkup('existing-markup', 'existing-editor'),
            identity: {
                id: asAnnotationId('existing-markup'),
                pdfjsUid: 'existing-editor',
                pdfRef: '7R',
            },
            subtype: 'Underline',
            geometry,
            persistedRevision: 0,
        };
        store.import(existing);
        const created: ITextMarkupEntity = {
            ...textMarkup('created-markup', 'created-editor'),
            subtype: 'Underline',
            geometry,
        };
        store.applyTextMarkupSelection(created, [{
            annotationId: existing.identity.id,
            observedGeometry: geometry,
        }]);

        expect(store.get(existing.identity.id)?.deleted).toBe(true);
        store.acknowledgeSave(store.beginSave(), new Map([[
            created.identity.id,
            '8R',
        ]]));

        expect(store.undo()).toBe(true);
        expect(store.get(existing.identity.id)).toMatchObject({
            deleted: false,
            identity: {pdfRef: '7R'},
            persistedRevision: 1,
        });
        expect(store.get(created.identity.id)).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.get(created.identity.id)).toMatchObject({
            identity: {pdfRef: '8R'},
            persistedRevision: 0,
        });
        expect(store.get(existing.identity.id)).toMatchObject({
            deleted: true,
            identity: {pdfRef: '7R'},
            persistedRevision: 1,
        });
    });

    it('leaves a never-acknowledged annotation transient through undo and redo', () => {
        const store = new AnnotationStore();
        const note = stickyNote('transient-note', 'transient-editor');
        store.createStickyNote(note);
        store.setNoteText(note.identity.id, 'draft');

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)?.persistedRevision).toBe(-1);
        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toBeNull();

        expect(store.redo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            persistedRevision: -1,
            identity: {pdfjsUid: 'transient-editor'},
        });
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('does not rebase history when a stale acknowledgement is rejected', () => {
        const store = new AnnotationStore();
        const note = stickyNote('stale-note', 'stale-editor');
        store.createStickyNote(note);
        const frontier = store.beginSave();
        store.setNoteText(note.identity.id, 'typed after the frontier');

        expect(() => store.acknowledgeSave(frontier, new Map([[
            note.identity.id,
            '55R',
        ]]))).toThrow(/staleRevisionError/u);

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({persistedRevision: -1});
        expect(store.get(note.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.resolveExternal({pdfRef: '55R'})).toBeNull();
    });

    it('adopts the newest acknowledged ref when a second save renames it', () => {
        const store = new AnnotationStore();
        const note = stickyNote('renamed-note', 'renamed-editor');
        store.createStickyNote(note);
        saveWithMaterializedRef(store, note.identity.id, '12R');
        store.setNoteText(note.identity.id, 'second revision');
        saveWithMaterializedRef(store, note.identity.id, '13R');

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({
            identity: {pdfRef: '13R'},
            persistedRevision: 1,
        });
        expect(store.resolveExternal({pdfRef: '12R'})).toBeNull();
    });

    it('drops a remembered identity once a later save writes bytes without it', () => {
        const store = new AnnotationStore();
        const markup = textMarkup('rewritten-markup', 'rewritten-editor');
        store.createTextMarkup(markup);
        saveWithMaterializedRef(store, markup.identity.id, '31R');

        expect(store.undo()).toBe(true);
        // The document is saved again while the create is undone, so the
        // annotation is gone from the file the acknowledgement describes.
        store.acknowledgeSave(store.beginSave());

        expect(store.redo()).toBe(true);
        expect(store.get(markup.identity.id)).toMatchObject({persistedRevision: -1});
        expect(store.get(markup.identity.id)?.identity.pdfRef).toBeUndefined();
        expect(store.resolveExternal({pdfRef: '31R'})).toBeNull();
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('keeps the saved ref on a delete the redo replays, so serialization can key it', () => {
        const store = new AnnotationStore();
        const note = stickyNote('serialized-note', 'serialized-editor');
        store.createStickyNote(note);
        store.delete(note.identity.id);
        expect(store.undo()).toBe(true);
        saveWithMaterializedRef(store, note.identity.id, '9R');

        expect(store.redo()).toBe(true);

        const frontier = store.beginSave();
        const plan = buildSerializationPlan(
            frontier,
            store.dirtyAt(frontier),
            store.list({includeDeleted: true}),
        );
        const deleteStep = plan.steps.find(step => step.operation === 'delete-annotation');

        expect(deleteStep?.annotationId).toBe(note.identity.id);
        expect(deleteStep?.fields.identity).toMatchObject({pdfRef: '9R'});
    });

    it('rebases each annotation independently across an interleaved history', () => {
        const store = new AnnotationStore();
        const first = stickyNote('first-note', 'first-editor');
        const second = stickyNote('second-note', 'second-editor');
        store.createStickyNote(first);
        store.createStickyNote(second);
        store.setNoteText(first.identity.id, 'first text');
        store.setNoteText(second.identity.id, 'second text');

        store.acknowledgeSave(store.beginSave(), new Map([
            [
                first.identity.id,
                '11R',
            ],
            [
                second.identity.id,
                '12R',
            ],
        ]));

        expect(store.undo()).toBe(true);
        expect(store.undo()).toBe(true);
        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '11R'},
            persistedRevision: 1,
            text: '',
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            text: '',
        });

        expect(store.redo()).toBe(true);
        expect(store.redo()).toBe(true);
        expect(store.get(first.identity.id)).toMatchObject({
            identity: {pdfRef: '11R'},
            persistedRevision: 1,
            text: 'first text',
        });
        expect(store.get(second.identity.id)).toMatchObject({
            identity: {pdfRef: '12R'},
            persistedRevision: 1,
            text: 'second text',
        });
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('keeps each note-text commit as its own undo step', () => {
        const store = new AnnotationStore();
        const note = stickyNote('typed-note', 'typed-editor');
        store.createStickyNote(note);
        store.setNoteText(note.identity.id, 'first commit');
        store.setNoteText(note.identity.id, 'second commit');

        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({text: 'first commit'});
        expect(store.undo()).toBe(true);
        expect(store.get(note.identity.id)).toMatchObject({text: ''});
        expect(store.canUndo).toBe(true);
    });

    it('drops a ref the record retired instead of restoring it from a replay', () => {
        const store = new AnnotationStore();
        const shape = persistedShape('retired-shape', '7R', 0.1);
        store.import(shape);
        store.setStyle(shape.identity.id, {color: '#00ff00'});

        // Rematerializing the shapes renumbers them, so the previous revision's
        // numbering is retired before the bytes below re-derive it.
        const frontier = store.beginSave();
        expect(store.primeImportedShapes([], frontier)).toBe(true);
        expect(store.resolveExternal({pdfRef: '7R'})).toBeNull();

        expect(store.undo()).toBe(true);
        const undone = store.get(shape.identity.id);
        expect(undone).not.toBeNull();
        expect(undone!.identity.pdfRef).toBeUndefined();
        expect(Object.hasOwn(undone!.identity, 'pdfRef')).toBe(false);
        expect(store.resolveExternal({pdfRef: '7R'})).toBeNull();

        expect(store.redo()).toBe(true);
        const redone = store.get(shape.identity.id);
        expect(redone).not.toBeNull();
        expect(redone!.identity.pdfRef).toBeUndefined();
        expect(Object.hasOwn(redone!.identity, 'pdfRef')).toBe(false);
        expect(store.resolveExternal({pdfRef: '7R'})).toBeNull();
    });

    it('does not let a replay claim a retired ref another annotation inherited', () => {
        const store = new AnnotationStore();
        const shape = persistedShape('renumbered-shape', '7R', 0.1);
        const survivor = persistedShape('surviving-shape', '8R', 0.5);
        store.import(shape);
        store.import(survivor);
        store.setStyle(shape.identity.id, {color: '#00ff00'});

        const frontier = store.beginSave();
        expect(store.primeImportedShapes([], frontier)).toBe(true);
        // The rewritten bytes hand the freed number to the survivor.
        store.bindIdentity({
            annotationId: survivor.identity.id,
            expectedRevision: survivor.revision,
            bindings: {pdfRef: '7R'},
        });

        expect(store.undo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '7R'})).toBe(survivor.identity.id);
        expect(store.get(shape.identity.id)?.identity.pdfRef).toBeUndefined();

        expect(store.redo()).toBe(true);
        expect(store.resolveExternal({pdfRef: '7R'})).toBe(survivor.identity.id);
        expect(store.get(shape.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('prices canonical snapshot commands by the entities they retain', () => {
        const {
            authority,
            commands,
        } = createRecordingHistoryAuthority();
        const store = new AnnotationStore(authority);
        const note = stickyNote('priced-note', 'priced-editor');
        store.createStickyNote(note);
        store.setNoteText(note.identity.id, 'x'.repeat(4096));

        const [
            createCommand,
            editCommand,
        ] = commands;

        // The create command wraps a clone of the note in one entry, so a priced
        // command can never come in under the note itself; an unpriced one would
        // report the ledger's flat fallback instead. That fallback is 1 KiB, which
        // over-charges this small create and under-charges the 4 KiB edit by an
        // order of magnitude, so only the edit is asserted against it.
        expect(createCommand?.estimatedBytes).toBeGreaterThan(estimateRetainedAnnotationBytes([note]));
        expect(editCommand?.estimatedBytes).toBeGreaterThan(8192);
        expect(editCommand!.estimatedBytes!).toBeGreaterThan(createCommand!.estimatedBytes!);
    });
});
