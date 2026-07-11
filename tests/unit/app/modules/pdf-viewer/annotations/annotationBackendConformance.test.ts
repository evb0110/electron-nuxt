import {
    describe,
    expect,
    it,
} from 'vitest';
import {asAnnotationId} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {requireDocumentRevisionToken} from '@contracts';
import {
    ANNOTATION_PERSISTENCE_BACKENDS,
    assertAnnotationBackendSemanticConformance,
    projectAnnotationBackendMutations,
    verifyAllAnnotationPersistenceBackends,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';

describe('annotation persistence backend conformance', () => {
    it('feeds all three backends the same ordered semantic program', () => {
        const store = new AnnotationStore();
        const noteId = asAnnotationId('annotation-note');
        const markupId = asAnnotationId('annotation-markup');
        store.createStickyNote({
            kind: 'sticky-note',
            identity: {
                id: noteId,
                pdfName: 'note-nm',
                pdfRef: '12R0',
            },
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: 'Test',
            text: 'שלום — semantic note',
            anchor: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
            color: '#ffcc00',
        });
        store.createTextMarkup({
            kind: 'text-markup',
            identity: {
                id: markupId,
                pdfName: 'markup-nm',
                pdfRef: '13 0 R',
            },
            pageIndex: 1,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            subtype: 'Squiggly',
            text: 'overlap',
            geometry: [{
                left: 0.3,
                top: 0.4,
                width: 0.2,
                height: 0.03,
            }],
            color: '#336699',
            opacity: 0.42,
        });
        store.delete(markupId);
        const frontier = store.beginSave();
        const plan = buildSerializationPlan(frontier, store.dirtyAt(frontier));
        expect(plan.changedObjectRefs).toEqual(['12 0 R']);
        expect(Object.isFrozen(plan)).toBe(true);
        expect(Object.isFrozen(plan.steps)).toBe(true);

        const programs = ANNOTATION_PERSISTENCE_BACKENDS.map(backend => (
            projectAnnotationBackendMutations(plan, backend)
        ));
        const semantics = programs.map(program => program.map(({
            backend: _backend,
            ...mutation
        }) => mutation));

        const expectedSemantics = semantics[0]!;
        expect(semantics[1]).toEqual(expectedSemantics);
        expect(semantics[2]).toEqual(expectedSemantics);
        expect(assertAnnotationBackendSemanticConformance(plan)).toEqual(expectedSemantics);
        expect(expectedSemantics.map(mutation => mutation.operation)).toEqual([
            'prepare-free-text-appearance',
            'delete-annotation',
            'write-free-text-contents',
            'bind-identities',
        ]);
        expect(expectedSemantics[2]?.fields).toMatchObject({
            text: 'שלום — semantic note',
            anchor: {
                width: 0.02,
                height: 0.02,
            },
        });
    });

    it('executes and reopens all three backend adapters against canonical entities', async () => {
        const store = new AnnotationStore();
        const noteId = asAnnotationId('backend-note');
        store.createStickyNote({
            kind: 'sticky-note',
            identity: {
                id: noteId,
                pdfName: 'backend-note',
            },
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: 1,
            modifiedAt: 2,
            author: 'Author',
            text: 'עברית Ω',
            anchor: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
            color: '#ffaa00',
            fidelity: {
                subject: 'semantic',
                flags: 4,
                rotation: 90,
                zOrder: 2,
            },
        });
        const frontier = store.beginSave();
        const plan = buildSerializationPlan(frontier, store.dirtyAt(frontier));
        const calls: string[] = [];
        const adapters = ANNOTATION_PERSISTENCE_BACKENDS.map((backend, index) => ({
            backend,
            apply: async (mutations: ReturnType<typeof projectAnnotationBackendMutations>) => {
                calls.push(`${backend}:${mutations.map(mutation => mutation.operation).join(',')}`);
                return new Uint8Array([index + 1]);
            },
            reopen: async () => plan.expected,
        }));
        const results = await verifyAllAnnotationPersistenceBackends(plan, adapters);
        expect(results.map(result => result.backend)).toEqual(ANNOTATION_PERSISTENCE_BACKENDS);
        expect(calls).toHaveLength(3);
        expect(calls.every(call => call.endsWith('prepare-free-text-appearance,write-free-text-contents,bind-identities'))).toBe(true);
    });

    it('refuses a partial backend conformance run', async () => {
        const store = new AnnotationStore();
        const plan = buildSerializationPlan(store.beginSave(), []);
        await expect(verifyAllAnnotationPersistenceBackends(plan, [])).rejects.toThrow('exactly one adapter');
    });

    it('captures one global immutable frontier for structure, metadata, OCR, annotations, and postconditions', () => {
        const store = new AnnotationStore();
        const pageLabels = [{
            startPage: 1,
            style: 'D' as const,
            prefix: '',
            startNumber: 1,
        }];
        const plan = buildSerializationPlan(store.beginSave(requireDocumentRevisionToken('revision-global')), [], [], {
            pageOperations: [{
                operation: 'rotate',
                pageIndexes: [0],
                fields: {degrees: 90},
            }],
            metadata: {pageLabels},
            ocrOperations: [{
                pageIndex: 0,
                operation: 'replace-text-layer',
                payloadHash: 'ocr-hash',
            }],
            routeConstraints: {
                allowedBackends: ['pdf-lib-rewrite'],
                forceRewrite: true,
            },
            postconditions: {
                expectedPageCount: 1,
                changedObjectRefs: ['7 0 R'],
            },
        });

        pageLabels[0]!.prefix = 'mutated-after-frontier';
        expect(plan.sourceRevision).toBe(requireDocumentRevisionToken('revision-global'));
        expect(plan.mutationOrder).toEqual([
            'page-tree',
            'metadata',
            'ocr',
            'annotations',
            'postconditions',
        ]);
        expect(plan.metadata.pageLabels?.[0]?.prefix).toBe('');
        expect(plan.pageOperations).toEqual([{
            operation: 'rotate',
            pageIndexes: [0],
            fields: {degrees: 90},
        }]);
        expect(plan.ocrOperations).toHaveLength(1);
        expect(plan.postconditions).toMatchObject({
            expectedPageCount: 1,
            requireValidXref: true,
        });
        expect(plan.changedObjectRefs).toEqual(['7 0 R']);
        expect(Object.isFrozen(plan)).toBe(true);
    });
});
