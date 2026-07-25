import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    asAnnotationId,
    type IStickyNoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type {
    IAnnotationCommentSummary,
    TAnnotationStableKey,
} from '@app/types/annotations';

function importPersistedHighlight(store: AnnotationStore) {
    const annotationId = asAnnotationId('persisted-highlight');
    store.import({
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
        text: '',
        geometry: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        }],
        color: '#ffff00',
        opacity: 1,
    });
    return annotationId;
}

function stickyNote(id: string, text: string): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {id: asAnnotationId(id)},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1_781_000_000_000,
        modifiedAt: null,
        author: null,
        text,
        anchor: {
            left: 0.1,
            top: 0.2,
            width: 0.01,
            height: 0.01,
        },
        color: '#ffcc00',
    };
}

describe('AnnotationStore saved semantic baseline', () => {
    it('keeps a save frontier current across external identity reconciliation', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        store.bindIdentity({
            annotationId,
            expectedRevision: 0,
            bindings: {
                pdfRef: '12R0',
                pdfName: 'canonical-highlight',
            },
        });

        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();
    });

    it('invalidates a save frontier when annotation content changes', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        store.setStyle(annotationId, {color: '#00ff00'});

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

        application.store.createStickyNote(stickyNote(
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
        application.ingestLegacySummaries([{
            source: 'editor',
            id: 'pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0' as TAnnotationStableKey,
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

        application.ingestLegacySummaries([{
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
        expect(application.store.get(canonicalId)?.identity).toEqual(expect.objectContaining({
            pdfName: canonicalId,
            pdfRef: '12R0',
        }));
    });

    it('adopts a complete initial editor snapshot even when PDF.js omits its persistent ref', () => {
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

        application.reconcileLegacySummaries([summary], {adoptAsSavedBaseline: true});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);

        application.reconcileLegacySummaries([]);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
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

        application.reconcileLegacySummaries([summary]);
        application.reconcileLegacySummaries([], {reconcileMissingTransient: false});

        expect(application.store.list()).toEqual([expect.objectContaining({
            deleted: false,
            text: 'draft',
        })]);
    });

    it('does not adopt an unsaved canonical note when the initial authoritative snapshot arrives late', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(stickyNote(
            'created-before-initial-sync',
            'Created before initial PDF.js sync',
        ));

        application.reconcileLegacySummaries([], {adoptAsSavedBaseline: true});

        const session = application.beginSave();
        expect(session.plan.expected).toEqual([expect.objectContaining({
            kind: 'sticky-note',
            text: 'Created before initial PDF.js sync',
        })]);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it('adopts only persisted snapshot entities when an unsaved canonical note predates initial sync', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(stickyNote(
            'unsaved-canonical-note',
            'Unsaved canonical note',
        ));
        application.reconcileLegacySummaries([{
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
        }], {adoptAsSavedBaseline: true});

        expect(application.beginSave().plan.expected).toEqual([expect.objectContaining({
            kind: 'sticky-note',
            text: 'Unsaved canonical note',
        })]);
    });

    it('does not let an empty authoritative PDF.js snapshot delete a canonical-only note it never observed', () => {
        const application = new AnnotationApplication('document');
        const summary: IAnnotationCommentSummary = {
            source: 'editor',
            id: 'pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0' as TAnnotationStableKey,
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
        application.ingestLegacySummaries([summary]);
        application.reconcileLegacySummaries([]);

        expect(application.store.list()).toEqual([expect.objectContaining({
            deleted: false,
            text: 'agent-created note',
        })]);
        expect(application.beginSave().plan.expected).toEqual([expect.objectContaining({
            deleted: false,
            text: 'agent-created note',
        })]);
    });

    it('tombstones an unsaved annotation when an authoritative editor snapshot removes it', () => {
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

        application.reconcileLegacySummaries([summary]);
        application.reconcileLegacySummaries([]);

        expect(application.store.list({includeDeleted: true})).toEqual([expect.objectContaining({deleted: true})]);
    });

    it('treats an editor projection with a real PDF ref as persisted on reopen', () => {
        const application = new AnnotationApplication('document');

        application.ingestLegacySummaries([{
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
        expect(store.dirtyAt(store.beginSave())).toEqual([]);
    });

    it('tracks a canonical embedded deletion independently of PDF.js storage', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);

        store.delete(annotationId);

        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.countDirtyPersistedDeletions()).toBe(1);
        expect(store.dirtyAt(store.beginSave())).toEqual([expect.objectContaining({
            deleted: true,
            identity: expect.objectContaining({id: annotationId}),
        })]);
    });

    it('adopts committed page remaps without adopting unrelated unsaved edits', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        store.setStyle(annotationId, {color: '#ff0000'});

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
        expect(store.dirtyAt(store.beginSave())).toEqual([expect.objectContaining({
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

        store.acknowledgeSave(deletionFrontier);
        expect(store.hasChangesSinceSavedBaseline()).toBe(false);
        expect(store.countDirtyPersistedDeletions()).toBe(0);

        expect(store.undo()).toBe(true);
        expect(store.hasChangesSinceSavedBaseline()).toBe(true);
        expect(store.dirtyAt(store.beginSave())).toEqual([expect.objectContaining({
            deleted: false,
            identity: expect.objectContaining({id: annotationId}),
        })]);
    });
});
