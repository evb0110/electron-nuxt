import {
    describe,
    expect,
    it,
} from 'vitest';
import {asAnnotationId} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';

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

describe('AnnotationStore save frontier rollback', () => {
    it('owns pending markup subtype intent so an immediate save can observe it', () => {
        const store = new AnnotationStore();
        store.setPendingMarkupSubtype([
            'editor-identity',
            '52R',
        ], 'Squiggly');

        expect(store.resolveMarkupSubtype(['editor-identity'])).toBe('Squiggly');
        expect(store.markupSubtypesByExternalId().get('52R')).toBe('Squiggly');

        store.clearPendingMarkupSubtypes();
        expect(store.resolveMarkupSubtype(['editor-identity'])).toBeNull();
    });

    it('rolls back only prepared shape identity while preserving semantic edits', () => {
        const application = new AnnotationApplication('document');
        const geometry = {
            id: 'local-shape',
            type: 'rectangle' as const,
            pageIndex: 0,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            color: '#123456',
            opacity: 1,
            strokeWidth: 2,
            source: 'local',
            stableKey: 'evb-shape:local-shape',
        } as const;
        const created = application.createShapeFromGeometry(geometry);
        const session = application.beginSave();

        expect(application.primePersistedShapes([{
            ...geometry,
            x: 0.8,
            color: '#abcdef',
            source: 'embedded',
            annotationId: '44R0',
            pdfSubtype: 'Square',
        }], session.frontier)).toBe(true);

        const primed = application.store.get(created.identity.id);
        expect(primed?.identity.pdfRef).toBe('44R0');
        expect(primed && 'geometry' in primed ? primed.geometry : null).toEqual(geometry);
        expect(() => application.assertSaveCurrent(session)).not.toThrow();

        application.setStyle(created.identity.id, {color: '#ff0000'});
        application.store.bindIdentity({
            annotationId: created.identity.id,
            expectedRevision: 1,
            bindings: {pdfName: 'later-identity'},
        });
        expect(() => application.assertSaveCurrent(session)).toThrow('staleRevisionError');

        expect(application.rollbackSave(session)).toBe(true);
        expect(application.store.get(created.identity.id)).toMatchObject({
            identity: {
                elementId: 'local-shape',
                pdfName: 'later-identity',
            },
            geometry: {color: '#ff0000'},
            persistedRevision: -1,
            revision: 1,
        });
        expect(application.store.get(created.identity.id)?.identity.pdfRef).toBeUndefined();
    });

    it('preserves concurrent authored mutations and new entities while failed-save rollback unwinds', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // Both edits are authored after capture and must remain canonical.
        store.setStyle(annotationId, {color: '#ff0000'});
        const noteId = asAnnotationId('rollback-note');
        store.createStickyNote({
            kind: 'sticky-note',
            identity: {id: noteId},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            text: 'created after the frontier was captured',
            anchor: {
                left: 0.5,
                top: 0.5,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
        });

        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
        expect(store.rollbackToSaveFrontier(frontier)).toBe(true);

        expect(store.get(annotationId)).toMatchObject({
            color: '#ff0000',
            revision: 1,
        });
        expect(store.get(noteId)).toMatchObject({text: 'created after the frontier was captured'});
        expect(store.resolveExternal({pdfRef: '12R0'})).toBe(annotationId);
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
    });

    it('preserves a late persisted import that the frontier deliberately tolerates', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // The initial scan discovers an already-persisted source annotation
        // after the frontier is captured; the frontier tolerates it.
        const lateId = asAnnotationId('late-persisted');
        store.import({
            kind: 'text-markup',
            identity: {
                id: lateId,
                pdfRef: '34R0',
            },
            pageIndex: 1,
            revision: 0,
            persistedRevision: 0,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            subtype: 'Highlight',
            text: '',
            geometry: [{
                left: 0.2,
                top: 0.3,
                width: 0.2,
                height: 0.04,
            }],
            color: '#00ffff',
            opacity: 1,
        });
        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();

        store.rollbackToSaveFrontier(frontier);

        expect(store.get(annotationId)).not.toBeNull();
        expect(store.get(lateId)).not.toBeNull();
    });

    it('rejects a concurrent editor mutation by CAS and preserves it on rollback', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // A captured semantic mutation lands mid-save: CAS must reject it.
        store.setStyle(annotationId, {color: '#00ff00'});
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow(
            'staleRevisionError: annotations changed after the save frontier was captured',
        );

        store.rollbackToSaveFrontier(frontier);
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
        expect(store.get(annotationId)).toMatchObject({
            color: '#00ff00',
            revision: 1,
        });
    });

    it('accepts identity reconciliation after capture but rejects semantic mutation', () => {
        const store = new AnnotationStore();
        const annotationId = importPersistedHighlight(store);
        const frontier = store.beginSave();

        // The materializing save binds the external identity it just wrote.
        store.bindIdentity({
            annotationId,
            expectedRevision: 0,
            bindings: {
                pdfRef: '12R0',
                pdfName: 'evb-note-1',
            },
        });
        expect(() => store.assertSaveFrontierCurrent(frontier)).not.toThrow();
        expect(store.get(annotationId)?.identity.pdfName).toBe('evb-note-1');

        store.setStyle(annotationId, {color: '#123456'});
        expect(() => store.assertSaveFrontierCurrent(frontier)).toThrow('staleRevisionError');
    });

    it('refuses a frontier another store captured even when the two are structurally identical', () => {
        const left = new AnnotationStore();
        const right = new AnnotationStore();
        const leftId = importPersistedHighlight(left);
        importPersistedHighlight(right);
        const leftFrontier = left.beginSave();
        const rightFrontier = right.beginSave();
        // Two documents opened from the same bytes capture equal frontier data.
        expect(rightFrontier.entityBaselineHash).toBe(leftFrontier.entityBaselineHash);
        expect([...rightFrontier.revisions]).toEqual([...leftFrontier.revisions]);

        left.setStyle(leftId, {color: '#00ff00'});
        const drifted = left.get(leftId);

        // A failed save unwinding in `finally` must neither throw nor let one
        // document's rollback rewrite the other document's annotations.
        expect(left.rollbackToSaveFrontier(rightFrontier)).toBe(false);
        expect(left.get(leftId)).toEqual(drifted);
        expect(() => left.assertSaveFrontierCurrent(rightFrontier)).toThrow('belongs to another store');

        expect(left.rollbackToSaveFrontier(leftFrontier)).toBe(true);
        expect(left.get(leftId)).toEqual(drifted);
    });

    it('reports a retired frontier instead of throwing when the document was replaced', () => {
        const retired = new AnnotationApplication('first-document');
        const session = retired.beginSave();
        const replacement = new AnnotationApplication('second-document');

        expect(replacement.rollbackSave(session)).toBe(false);
        expect(retired.rollbackSave(session)).toBe(true);
    });

    it('preserves post-frontier application mutations when a save fails', () => {
        const application = new AnnotationApplication('document');
        application.createStickyNote({
            kind: 'sticky-note',
            pageIndex: 0,
            createdAt: null,
            modifiedAt: null,
            author: null,
            text: 'note to persist',
            anchor: {
                left: 0.1,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
        });
        const session = application.beginSave();

        // A second note is created after the frontier; the save then fails.
        application.createStickyNote({
            kind: 'sticky-note',
            pageIndex: 0,
            createdAt: null,
            modifiedAt: null,
            author: null,
            text: 'created after save started',
            anchor: {
                left: 0.3,
                top: 0.4,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
        });
        expect(() => application.assertSaveCurrent(session)).toThrow('staleRevisionError');

        application.rollbackSave(session);

        expect(application.store.list()).toEqual([
            expect.objectContaining({text: 'note to persist'}),
            expect.objectContaining({text: 'created after save started'}),
        ]);
        expect(() => application.assertSaveCurrent(session)).toThrow('staleRevisionError');
    });
});
