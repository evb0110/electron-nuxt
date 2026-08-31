import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    asAnnotationId,
    type INoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {
    IAnnotationCommentSummary,
    TAnnotationStableKey,
} from '@app/types/annotations';

function persistedHighlight() {
    const annotationId = asAnnotationId('persisted-highlight');
    return {
        kind: 'text-markup',
        identity: {
            id: annotationId,
            pdfRef: '12R0',
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        subtype: 'Highlight',
        contents: '',
        quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }],
        color: '#ffff00',
        opacity: 1,
    } as const;
}

function importPersistedHighlight(store: AnnotationStore) {
    const entity = persistedHighlight();
    store.replaceFromDocument([entity], []);
    const annotationId = entity.identity.id;
    return annotationId;
}

function note(id: string, contents: string): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1_781_000_000_000,
        modifiedAt: null,
        author: null,
        contents,
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.01,
            height: 0.01,
        },
        color: '#ffcc00',
        open: false,
    };
}

describe('AnnotationStore saved semantic baseline', () => {
    it('keeps a save frontier current across external identity reconciliation', () => {
        const store = new AnnotationStore();
        importPersistedHighlight(store);
        const frontier = store.beginSave();

        store.replaceFromDocument([persistedHighlight()], []);

        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();
    });

    it('invalidates a save frontier when annotation content changes', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        store.updateTextMarkup(annotationId, {color: '#00ff00'});

        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow(
            'staleRevisionError: annotations changed after the save frontier was captured',
        );
    });

    it('keeps a save frontier current when the initial scan discovers a persisted source annotation', () => {
        const store = new AnnotationStore();
        const frontier = store.beginSave();

        importPersistedHighlight(store);

        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();
    });

    it('invalidates a save frontier when a new unsaved annotation is created', () => {
        const application = new AnnotationApplication('document');
        const frontier = application.beginSave();

        application.store.createNote(note(
            'created-after-save-started',
            'created after save started',
        ));

        expect(() => application.assertSaveCurrent(frontier)).toThrow(
            'staleRevisionError: annotations changed after the save frontier was captured',
        );
    });

    it('binds a saved PDF ref back to the canonical ID written in /NM', () => {
        const application = new AnnotationApplication('document');
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        };
        application.replaceFromDocumentSummaries([{
            source: 'editor',
            id: 'pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            subtype: 'Highlight',
            author: null,
            createdAt: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'pdfjs_internal_editor_0',
            annotationId: null,
            annotationName: null,
            hasNote: false,
            markerRect,
        }]);
        const canonicalId = application.store.list()[0]!.identity.id;

        application.replaceFromDocumentSummaries([{
            appAnnotationId: canonicalId,
            source: 'pdf',
            id: '12R0',
            stableKey: 'ann:0:12R0' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            subtype: 'Highlight',
            author: null,
            createdAt: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: null,
            annotationId: '12R0',
            annotationName: canonicalId,
            hasNote: false,
            markerRect,
        }]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.store.get(canonicalId)?.identity).toEqual(expect.objectContaining({pdfRef: '12R'}));
    });

    it('treats an editor snapshot without a persistent ref as a clean parse result', () => {
        const application = new AnnotationApplication('document');
        const summary: IAnnotationCommentSummary = {
            source: 'editor',
            id: 'pdfjs-editor-1',
            stableKey: 'editor:0:pdfjs-editor-1' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            subtype: 'Highlight',
            author: null,
            createdAt: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'pdfjs-editor-1',
            annotationId: null,
            annotationName: null,
            hasNote: false,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            },
        };

        application.replaceFromDocumentSummaries([summary]);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);

        application.replaceFromDocumentSummaries([]);
        expect(application.store.list()).toEqual([]);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('does not tombstone an unsaved annotation when a degraded snapshot omits editors', () => {
        const application = new AnnotationApplication('document');
        const summary: IAnnotationCommentSummary = {
            source: 'editor',
            id: 'pdfjs-editor-1',
            stableKey: 'editor:0:pdfjs-editor-1' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: 'draft',
            subtype: 'FreeText',
            author: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'pdfjs-editor-1',
            annotationId: null,
            hasNote: true,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.03,
                height: 0.03,
            },
        };

        application.replaceFromDocumentSummaries([summary]);
        const [entity] = application.store.list();
        if (!entity || entity.kind !== 'note') {
            throw new Error('Expected the editor summary to enter as a note');
        }
        application.store.updateNote(entity.identity.id, {contents: 'edited draft'});
        application.replaceFromDocumentSummaries([]);

        expect(application.store.list()).toEqual([expect.objectContaining({
            deleted: false,
            contents: 'edited draft',
        })]);
    });

    it('does not adopt an unsaved canonical note when the initial authoritative snapshot arrives late', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note(
            'created-before-initial-sync',
            'Created before initial PDF.js sync',
        ));

        application.replaceFromDocumentSummaries([]);

        const session = application.beginSave();
        expect(session.plan.expected).toEqual([expect.objectContaining({
            kind: 'note',
            contents: 'Created before initial PDF.js sync',
        })]);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('adopts only persisted snapshot entities when an unsaved canonical note predates initial sync', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note(
            'unsaved-canonical-note',
            'Unsaved canonical note',
        ));
        application.replaceFromDocumentSummaries([{
            source: 'pdf',
            id: '13271R',
            stableKey: 'ann:0:13271R' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: 'Existing persisted note',
            subtype: 'FreeText',
            author: null,
            createdAt: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: '13271R',
            annotationName: null,
            hasNote: true,
            markerRect: {
                left: 0.2,
                top: 0.3,
                width: 0.01,
                height: 0.01,
            },
        }]);

        expect(application.beginSave().plan.expected).toEqual([expect.objectContaining({
            kind: 'note',
            contents: 'Unsaved canonical note',
        })]);
    });

    it('does not let an empty authoritative PDF.js snapshot delete a canonical-only note it never observed', () => {
        const application = new AnnotationApplication('document');
        const summary: IAnnotationCommentSummary = {
            source: 'editor',
            id: 'pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: 'agent-created note',
            subtype: 'FreeText',
            author: null,
            createdAt: 1_781_000_000_000,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'pdfjs_internal_editor_0',
            annotationId: null,
            hasNote: true,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
        };

        // Open-note/agent ingress owns this entity before PDF.js has ever
        // included it in a complete editor snapshot.
        application.replaceFromDocumentSummaries([summary]);
        const [entity] = application.store.list();
        if (!entity || entity.kind !== 'note') {
            throw new Error('Expected the note summary to enter as a note');
        }
        application.store.updateNote(entity.identity.id, {contents: 'edited agent-created note'});
        application.replaceFromDocumentSummaries([]);

        expect(application.store.list()).toEqual([expect.objectContaining({
            deleted: false,
            contents: 'edited agent-created note',
        })]);
        expect(application.beginSave().plan.expected).toEqual([expect.objectContaining({
            deleted: false,
            contents: 'edited agent-created note',
        })]);
    });

    it('retains a dirty annotation when an authoritative editor snapshot omits it', () => {
        const application = new AnnotationApplication('document');
        const summary: IAnnotationCommentSummary = {
            source: 'editor',
            id: 'pdfjs-editor-1',
            stableKey: 'editor:0:pdfjs-editor-1' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: 'draft',
            subtype: 'FreeText',
            author: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'pdfjs-editor-1',
            annotationId: null,
            hasNote: true,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.03,
                height: 0.03,
            },
        };

        application.replaceFromDocumentSummaries([summary]);
        const [entity] = application.store.list();
        if (!entity || entity.kind !== 'note') {
            throw new Error('Expected the editor summary to enter as a note');
        }
        application.store.updateNote(entity.identity.id, {contents: 'edited draft'});
        application.replaceFromDocumentSummaries([]);

        expect(application.store.list({includeDeleted: true})).toEqual([expect.objectContaining({
            deleted: false,
            contents: 'edited draft',
        })]);
    });

    it('treats an editor projection with a real PDF ref as persisted on reopen', () => {
        const application = new AnnotationApplication('document');

        application.replaceFromDocumentSummaries([{
            source: 'editor',
            id: 'pdfjs-editor-1',
            stableKey: 'ann:0:12R0' as TAnnotationStableKey,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            subtype: 'Highlight',
            author: null,
            createdAt: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'pdfjs-editor-1',
            annotationId: '12R0',
            annotationName: null,
            hasNote: false,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            },
        }]);

        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(application.store.list()).toEqual([expect.objectContaining({persistedRevision: 0})]);
    });

    it('adopts persisted imports without reporting a dirty document', () => {
        const store = new AnnotationStore();

        importPersistedHighlight(store);

        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.dirtyEntities()).toEqual([]);
    });

    it('tracks a canonical embedded deletion independently of PDF.js storage', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);

        store.delete(annotationId);

        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.countDirtyPersistedDeletions()).toBe(1);
        expect(store.dirtyEntities()).toEqual([expect.objectContaining({
            deleted: true,
            identity: expect.objectContaining({id: annotationId}),
        })]);
    });

    it('adopts committed page remaps without adopting unrelated unsaved edits', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        store.updateTextMarkup(annotationId, {color: '#ff0000'});

        store.remapPages({
            previousPageCount: 2,
            pages: [
                {fromPageNumber: 2},
                {fromPageNumber: 1},
            ],
        });

        expect(store.get(annotationId)).toMatchObject({
            pageIndex: 1,
            color: '#ff0000',
        });
        expect(store.dirtyEntities()).toEqual([expect.objectContaining({
            pageIndex: 1,
            color: '#ff0000',
        })]);
    });

    it('adopts annotations removed by a committed page deletion as saved tombstones', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);

        store.remapPages({
            previousPageCount: 1,
            pages: [],
        });

        expect(store.get(annotationId)).toMatchObject({deleted: true});
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.countDirtyPersistedDeletions()).toBe(0);
    });

    it('invalidates an in-flight save frontier when committed page geometry changes', () => {
        const store = new AnnotationStore();
        importPersistedHighlight(store);
        const frontier = store.beginSave();

        store.remapPages({
            previousPageCount: 2,
            pages: [
                {fromPageNumber: 2},
                {fromPageNumber: 1},
            ],
        });

        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
    });

    it('rebases only after save acknowledgement and stays dirty when undo crosses that save', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        store.delete(annotationId);
        const deletionFrontier = store.beginSave();

        store.markPersisted(deletionFrontier, []);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.countDirtyPersistedDeletions()).toBe(0);

        expect(store.undo()).toBe(true);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.dirtyEntities()).toEqual([expect.objectContaining({
            deleted: false,
            identity: expect.objectContaining({id: annotationId}),
        })]);
    });
});

describe('AnnotationApplication deleted embedded annotation ids', () => {
    it('reports a deleted file-resident annotation of any kind until it is restored', () => {
        const application = new AnnotationApplication('document');
        const annotationId = importPersistedHighlight(application.store);
        expect(application.deletedEmbeddedAnnotationIds()).toEqual(new Set());

        // Text markup lives in the file until a save rewrites it, so the
        // annotation layer would repaint it from the document on the next
        // render unless the deletion is reported here.
        application.store.delete(annotationId);
        expect(application.deletedEmbeddedAnnotationIds()).toEqual(new Set(['12R']));

        expect(application.store.undo()).toBe(true);
        expect(application.deletedEmbeddedAnnotationIds()).toEqual(new Set());
    });

    it('ignores a deleted annotation that the file never contained', () => {
        const application = new AnnotationApplication('document');
        const localNote = note('local-note', 'draft');
        application.store.createNote(localNote);

        application.store.delete(localNote.identity.id);
        expect(application.deletedEmbeddedAnnotationIds()).toEqual(new Set());
    });
});
