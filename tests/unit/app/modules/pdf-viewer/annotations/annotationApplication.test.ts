import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type IStickyNoteEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import type { IShapeAnnotation } from '@app/types/annotations';

const pdfjsMocks = vi.hoisted(() => ({
    configureWorker: vi.fn(),
    createDocumentOptions: vi.fn(() => ({verbosity: 0})),
    destroy: vi.fn(async () => {}),
    getDocument: vi.fn(),
}));

const documentFileMocks = vi.hoisted(() => ({
    readFileRange: vi.fn(),
    statFile: vi.fn(),
}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    configurePdfjsWorkerSrc: pdfjsMocks.configureWorker,
    createPdfjsDocumentOptions: pdfjsMocks.createDocumentOptions,
}));

vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => documentFileMocks}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    getDocument: pdfjsMocks.getDocument,
    PDFDataRangeTransport: class {
        public constructor(
            public readonly length: number,
            public readonly initialData: Uint8Array,
        ) {}

        public onDataRange() {}
    },
}));

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

function textMarkup(overrides: Partial<ITextMarkupEntity> = {}): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: {
            id: asAnnotationId('persisted-underline'),
            pdfRef: 'underline-ref',
        },
        pageIndex: 0,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Tester',
        subtype: 'Underline',
        text: '',
        geometry: [{
            left: 0.1,
            top: 0.2,
            width: 0.4,
            height: 0.03,
        }],
        color: '#ffff00',
        opacity: 1,
        ...overrides,
    };
}

describe('AnnotationApplication', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        documentFileMocks.statFile.mockResolvedValue({size: 2 * 1024 * 1024});
        documentFileMocks.readFileRange.mockResolvedValue(new Uint8Array(1024 * 1024));
        pdfjsMocks.getDocument.mockReturnValue({promise: Promise.resolve({
            destroy: pdfjsMocks.destroy,
            getPage: vi.fn(),
        })});
    });

    it('semantically verifies a large staged PDF through bounded range reads', async () => {
        const application = new AnnotationApplication('document');
        const session = application.beginSave();
        const knownSize = 512 * 1024 * 1024;
        documentFileMocks.statFile.mockResolvedValue({size: knownSize});

        await application.verifySavePath(session, '/tmp/large-staged.pdf', knownSize);

        expect(documentFileMocks.readFileRange).toHaveBeenCalledWith(
            '/tmp/large-staged.pdf',
            0,
            1024 * 1024,
        );
        expect(documentFileMocks.readFileRange).toHaveBeenCalledTimes(1);
        expect(pdfjsMocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({
            length: knownSize,
            rangeChunkSize: 1024 * 1024,
            disableAutoFetch: true,
            disableStream: true,
        }));
        expect(pdfjsMocks.destroy).toHaveBeenCalledOnce();
    });

    it('configures the reopened PDF.js runtime before verifying saved bytes', async () => {
        const application = new AnnotationApplication('document');
        const session = application.beginSave();
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);

        await application.verifySaveBytes(session, bytes);

        expect(pdfjsMocks.configureWorker).toHaveBeenCalledOnce();
        expect(pdfjsMocks.createDocumentOptions).toHaveBeenCalledOnce();
        expect(pdfjsMocks.getDocument).toHaveBeenCalledWith({
            data: bytes,
            verbosity: 0,
        });
        expect(pdfjsMocks.configureWorker.mock.invocationCallOrder[0])
            .toBeLessThan(pdfjsMocks.getDocument.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
    });

    it('reconciles PDF.js editor undo and redo without adopting a new saved baseline', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('persisted-note');
        application.store.import(note({
            identity: {
                id: annotationId,
                pdfjsUid: 'pdfjs-editor-1',
            },
            persistedRevision: 0,
        }));
        application.delete(annotationId);
        const savedDelete = application.store.beginSave();
        application.store.acknowledgeSave(savedDelete);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);

        application.reconcilePdfjsEditorPresence(new Set(['pdfjs-editor-1']));

        expect(application.store.get(annotationId)?.deleted).toBe(false);
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);

        const transientId = asAnnotationId('transient-note');
        application.store.import(note({identity: {
            id: transientId,
            pdfjsUid: 'pdfjs-editor-2',
        }}));
        application.reconcilePdfjsEditorPresence(new Set(['pdfjs-editor-1']));
        expect(application.store.get(transientId)?.deleted).toBe(true);
        application.reconcilePdfjsEditorPresence(new Set([
            'pdfjs-editor-1',
            'pdfjs-editor-2',
        ]));
        expect(application.store.get(transientId)?.deleted).toBe(false);
    });

    it('rejects a pre-existing identical markup when the new canonical annotation identity is missing', async () => {
        const application = new AnnotationApplication('document');
        application.store.createTextMarkup({
            kind: 'text-markup',
            identity: {
                id: asAnnotationId('anno_new_markup'),
                elementId: 'pdfjs_internal_editor_17',
                pdfjsUid: 'editor-uid-before-save',
            },
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
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
                height: 0.1,
            }],
            color: '#ffff00',
            opacity: 1,
        });
        const getPage = vi.fn(async () => ({
            view: [
                0,
                0,
                100,
                100,
            ],
            getAnnotations: vi.fn(async () => [{
                id: '9R',
                subtype: 'Highlight',
                rect: [
                    10,
                    70,
                    40,
                    80,
                ],
            }]),
        }));
        pdfjsMocks.getDocument.mockReturnValue({promise: Promise.resolve({
            destroy: pdfjsMocks.destroy,
            getPage,
        })});

        await expect(application.verifySaveBytes(
            application.beginSave(),
            new Uint8Array([1]),
        )).rejects.toThrow('anno_new_markup: missing');
    });

    it('verifies and adopts a newly persisted PDF.js markup through save-time identity evidence', async () => {
        const application = new AnnotationApplication('document');
        application.store.createTextMarkup({
            kind: 'text-markup',
            identity: {
                id: asAnnotationId('anno_new_markup'),
                elementId: 'pdfjs_internal_editor_17',
                pdfjsUid: 'editor-uid-before-save',
            },
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
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
                height: 0.1,
            }],
            color: '#ffff00',
            opacity: 1,
        });
        const record = {
            subtype: 'Highlight',
            rect: [
                10,
                70,
                40,
                80,
            ],
        };
        pdfjsMocks.getDocument.mockReturnValue({promise: Promise.resolve({
            destroy: pdfjsMocks.destroy,
            getPage: vi.fn(async () => ({
                view: [
                    0,
                    0,
                    100,
                    100,
                ],
                getAnnotations: vi.fn(async () => [{
                    ...record,
                    id: '9R',
                }]),
            })),
        })});

        const session = application.beginSave();
        application.recordMaterializedIdentityBinding(session, 'anno_new_markup', '9R');

        await expect(application.verifySaveBytes(
            session,
            new Uint8Array([1]),
        )).resolves.toBeUndefined();
        application.acknowledgeSave(session);
        expect(application.store.get(asAnnotationId('anno_new_markup'))).toEqual(expect.objectContaining({
            identity: expect.objectContaining({pdfRef: '9R'}),
            persistedRevision: 0,
        }));
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('semantically verifies and binds a newly appended native FreeText note when PDF.js omits its annotation name', async () => {
        const application = new AnnotationApplication('document');
        const editorNote = note({
            identity: {
                id: asAnnotationId('anno_native_note'),
                elementId: 'pdfjs_internal_editor_0',
            },
            createdAt: 1_781_000_000_000,
            anchor: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            text: 'Native note text',
        });
        application.store.createStickyNote(editorNote);
        pdfjsMocks.getDocument.mockReturnValue({promise: Promise.resolve({
            destroy: pdfjsMocks.destroy,
            getPage: vi.fn(async () => ({
                view: [
                    0,
                    0,
                    1000,
                    1000,
                ],
                getAnnotations: vi.fn(async () => [{
                    id: '42R',
                    subtype: 'FreeText',
                    contents: 'Native note text',
                    rect: [
                        100,
                        798.4,
                        101.6,
                        800,
                    ],
                }]),
            })),
        })});

        const session = application.beginSave();
        await expect(application.verifySaveBytes(
            session,
            new Uint8Array([1]),
            {preexistingPdfAnnotationRefs: []},
        )).resolves.toBeUndefined();
        expect(session.materializedPdfRefs.get(asAnnotationId('anno_native_note'))).toBe('42R');
        application.acknowledgeSave(session);
        expect(application.store.get(asAnnotationId('anno_native_note')))
            .toEqual(expect.objectContaining({identity: expect.objectContaining({pdfRef: '42R'})}));
    });

    it('does not adopt a semantically identical pre-existing FreeText note as a new native append', async () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note({
            identity: {
                id: asAnnotationId('anno_native_note'),
                elementId: 'pdfjs_internal_editor_0',
            },
            createdAt: 1_781_000_000_000,
            anchor: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            text: 'Native note text',
        }));
        pdfjsMocks.getDocument.mockReturnValue({promise: Promise.resolve({
            destroy: pdfjsMocks.destroy,
            getPage: vi.fn(async () => ({
                view: [
                    0,
                    0,
                    1000,
                    1000,
                ],
                getAnnotations: vi.fn(async () => [{
                    id: '42R',
                    subtype: 'FreeText',
                    contents: 'Native note text',
                    rect: [
                        100,
                        798.4,
                        101.6,
                        800,
                    ],
                }]),
            })),
        })});

        await expect(application.verifySaveBytes(
            application.beginSave(),
            new Uint8Array([1]),
            {preexistingPdfAnnotationRefs: ['42R']},
        )).rejects.toThrow('anno_native_note: missing');
    });

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

    it('verifies deletion of an annotation from a removed trailing page without opening that page', async () => {
        const application = new AnnotationApplication('document');
        application.store.import(note({
            pageIndex: 1,
            persistedRevision: 0,
        }));
        application.delete(asAnnotationId('anno_test'));
        const getPage = vi.fn();
        pdfjsMocks.getDocument.mockReturnValue({promise: Promise.resolve({
            destroy: pdfjsMocks.destroy,
            getPage,
            numPages: 1,
        })});

        await expect(application.verifySaveBytes(
            application.beginSave(),
            new Uint8Array([1]),
        )).resolves.toBeUndefined();
        expect(getPage).not.toHaveBeenCalled();
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

    it('treats a repeated canonical delete delivery as an idempotent no-op', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('anno_test');
        application.store.createStickyNote(note());

        const firstDelete = application.delete(annotationId);
        const repeatedDelete = application.delete(annotationId);

        expect(repeatedDelete).toEqual(firstDelete);
        expect(repeatedDelete).toMatchObject({
            deleted: true,
            revision: 1,
        });
        expect(application.undo()).toBe(true);
        expect(application.store.get(annotationId)).toMatchObject({
            deleted: false,
            revision: 0,
        });
    });

    it('replaces overlapping markup in one observable and undoable Store command', () => {
        const application = new AnnotationApplication('document');
        const existing = textMarkup();
        application.store.import(existing);
        let emissions = 0;
        application.store.subscribe(() => {
            emissions += 1;
        });
        emissions = 0;

        const projection = application.applyTextMarkupSelection({
            kind: 'text-markup',
            pageIndex: 0,
            subtype: 'Underline',
            text: '',
            geometry: [{
                left: 0.2,
                top: 0.2,
                width: 0.1,
                height: 0.03,
            }],
            color: '#00ff00',
            opacity: 1,
            author: 'Tester',
            createdAt: 2,
            modifiedAt: 2,
            overlapCandidates: [{
                annotationId: existing.identity.id,
                observedGeometry: existing.geometry,
            }],
        });

        expect(emissions).toBe(1);
        expect(projection.replacements).toHaveLength(1);
        expect(projection.replacements[0]).toMatchObject({
            annotationId: existing.identity.id,
            deleted: false,
        });
        expect(projection.replacements[0]?.geometry).toHaveLength(2);
        expect(projection.replacements[0]?.geometry[0]).toEqual({
            left: 0.1,
            top: 0.2,
            width: 0.1,
            height: 0.03,
        });
        expect(projection.replacements[0]?.geometry[1]?.left).toBeCloseTo(0.3);
        expect(projection.replacements[0]?.geometry[1]?.width).toBeCloseTo(0.2);
        expect(application.store.list()).toHaveLength(2);

        expect(application.undo()).toBe(true);
        expect(application.store.list()).toEqual([existing]);
        expect(application.redo()).toBe(true);
        expect(application.store.list()).toHaveLength(2);
    });

    it('binds a created editor to its canonical markup without duplicate legacy ingestion', () => {
        const application = new AnnotationApplication('document');
        const projection = application.applyTextMarkupSelection({
            kind: 'text-markup',
            pageIndex: 0,
            subtype: 'Highlight',
            text: '',
            geometry: [{
                left: 0.1,
                top: 0.2,
                width: 0.2,
                height: 0.03,
            }],
            color: '#ffff00',
            opacity: 1,
            author: null,
            createdAt: 1,
            modifiedAt: 1,
            overlapCandidates: [],
        });
        const summary = {
            appAnnotationId: projection.created.identity.id,
            id: 'editor-1',
            stableKey: 'src:editor:0:editor-1' as const,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            subtype: 'Highlight' as const,
            author: null,
            modifiedAt: null,
            color: '#ffff00',
            uid: 'uid-1',
            annotationId: null,
            source: 'editor' as const,
            hasNote: false,
            markerRect: projection.created.geometry[0]!,
        };

        application.bindEditorSummaryIdentity(projection.created.identity.id, summary);
        application.ingestLegacySummaries([summary]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.annotationIdForSummary(summary)).toBe(projection.created.identity.id);
    });

    it('rejects reopen results with stale text or geometry', async () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note());
        const session = application.beginSave();
        await expect(application.verifyAndAcknowledgeSave(session, new Uint8Array([1]), {reopen: async () => [note({text: 'stale'})]})).rejects.toThrow('text mismatch');
    });

    it('publishes shape undo and redo to subscribers from the single canonical history command', () => {
        const application = new AnnotationApplication('document');
        const projected: IShapeAnnotation[][] = [];
        application.store.subscribe(() => {
            projected.push(application.store.listShapes().map(entity => entity.geometry));
        });

        application.createShapeFromGeometry(shape());
        const annotationId = application.annotationIdForShape(shape());

        expect(annotationId).not.toBeNull();
        expect(projected.at(-1)).toHaveLength(1);
        expect(application.undo()).toBe(true);
        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(projected.at(-1)).toEqual([]);
        expect(application.redo()).toBe(true);
        expect(application.store.get(annotationId!)).toMatchObject({kind: 'shape'});
        expect(projected.at(-1)).toHaveLength(1);
    });

    it('remaps surviving annotation and shape identities through a page-tree delta', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note({pageIndex: 0}));
        application.createShapeFromGeometry(shape({pageIndex: 2}));
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
