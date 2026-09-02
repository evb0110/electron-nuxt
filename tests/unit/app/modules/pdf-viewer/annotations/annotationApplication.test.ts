import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    AnnotationApplication,
    toCanonicalShapeEntity,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type INoteEntity,
    type IPlacedImageEntity,
    type ITextBoxEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';

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

function note(overrides: Partial<INoteEntity> = {}): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId('anno_test')},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Tester',
        contents: 'original',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
        open: false,
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
        contents: '',
        quadPoints: [{
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

function textBox(overrides: Partial<ITextBoxEntity> = {}): ITextBoxEntity {
    return {
        kind: 'text-box',
        identity: {id: asAnnotationId('text-box-test')},
        pageIndex: 0,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: 1,
        modifiedAt: 1,
        author: 'Tester',
        text: 'saved text',
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.15,
        },
        rotation: 0,
        fontSize: 10,
        color: '#ff00aa',
        ...overrides,
    };
}

function placedImage(overrides: Partial<IPlacedImageEntity> = {}): IPlacedImageEntity {
    return {
        kind: 'placed-image',
        identity: {
            id: asAnnotationId('placed-image-app-1'),
            pdfRef: '44R',
        },
        pageIndex: 2,
        revision: 0,
        persistedRevision: 0,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        rect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
        },
        rotation: 0,
        image: {
            objectNumber: 44,
            generationNumber: 0,
            byteLength: 16,
            sha256: 'a'.repeat(64),
        },
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

    it('projects a canonical placed image and preserves its PDF reference across reopen', () => {
        const application = new AnnotationApplication('document');
        const imported = placedImage();
        application.store.replaceFromDocument([imported], []);

        const [entity] = application.store.list();
        expect(entity).toMatchObject({
            kind: 'placed-image',
            pageIndex: 2,
            identity: {pdfRef: '44R'},
        });

        const [projected] = application.listCommentSummaries();
        expect(projected).toMatchObject({
            source: 'pdf',
            appAnnotationId: entity?.identity.id,
            annotationId: '44R',
            annotationName: null,
            subtype: 'Stamp',
            hasNote: false,
            markerRect: imported.rect,
        });

        const reopened = new AnnotationApplication('document');
        const reopenedImage = placedImage({
            identity: {
                id: imported.identity.id,
                pdfRef: '91R',
            },
            rect: {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.5,
            },
        });
        reopened.store.replaceFromDocument([reopenedImage], []);

        const [reopenedEntity] = reopened.store.list();
        if (!reopenedEntity || reopenedEntity.kind !== 'placed-image') {
            throw new Error('Expected a placed-image entity after reopen');
        }
        expect(reopenedEntity.identity.id).toBe(entity?.identity.id);
        expect(reopenedEntity?.identity.pdfRef).toBe('91R');
        expect(reopenedEntity.rect).toEqual(reopenedImage.rect);
        expect(reopened.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('keeps sticky-note projection note-bearing', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note());
        const [summary] = application.listCommentSummaries();

        expect(summary?.hasNote).toBe(true);
    });

    it('projects a Popup-backed PDF note through its canonical PDF identity', () => {
        const application = new AnnotationApplication('document');

        application.replaceFromDocumentSummaries([{
            id: '886 0 R',
            stableKey: 'nm:evb-pdf-003-text-parent',
            pageIndex: 0,
            pageNumber: 1,
            text: 'imported Popup note',
            subtype: 'Text',
            author: 'EVB PDF-003',
            modifiedAt: null,
            color: '#ffff00',
            uid: null,
            annotationId: '886 0 R',
            annotationName: 'evb-pdf-003-text-parent',
            source: 'pdf',
            hasNote: true,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.03,
            },
            replies: [{
                objectNumber: 887,
                generationNumber: 0,
                contents: 'A reply from the document',
                author: 'Reply author',
                createdAt: 2,
                modifiedAt: 2,
            }],
        }]);

        expect(application.store.list()).toMatchObject([{
            kind: 'note',
            contents: 'imported Popup note',
            identity: {pdfRef: '886R'},
            replies: [{
                contents: 'A reply from the document',
                author: 'Reply author',
            }],
        }]);
        expect(application.listCommentSummaries()).toMatchObject([{
            source: 'pdf',
            annotationId: '886R',
            annotationName: null,
            stableKey: 'ann:0:886R',
            subtype: 'Text',
            text: 'imported Popup note',
            hasNote: true,
            replies: [{
                contents: 'A reply from the document',
                author: 'Reply author',
            }],
        }]);
    });

    it('imports a persisted non-point FreeText editor into the canonical store', () => {
        const application = new AnnotationApplication('document');

        application.replaceFromDocumentSummaries([{
            id: '44R',
            stableKey: 'ann:0:44R',
            pageIndex: 0,
            pageNumber: 1,
            text: 'visible imported text',
            subtype: 'FreeText',
            author: null,
            modifiedAt: null,
            color: '#ff00aa',
            uid: 'pdfjs-editor-44R',
            annotationId: '44R',
            source: 'editor',
            hasNote: false,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.15,
            },
        }]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.store.list()[0]).toMatchObject({
            kind: 'text-box',
            text: 'visible imported text',
            pageIndex: 0,
            identity: {pdfRef: '44R'},
        });
    });

    it('projects one PDF-backed non-point FreeText from PDF and editor snapshots', () => {
        const application = new AnnotationApplication('document');
        const markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.15,
        };

        application.replaceFromDocumentSummaries([
            {
                id: '42R',
                stableKey: 'nm:imported-freetext',
                pageIndex: 0,
                pageNumber: 1,
                text: 'visible imported text from Contents',
                subtype: 'FreeText',
                author: null,
                modifiedAt: null,
                color: '#ff00aa',
                uid: null,
                annotationId: '42R',
                annotationName: 'imported-freetext',
                source: 'pdf',
                hasNote: false,
                markerRect,
            },
            {
                id: '42R0',
                stableKey: 'ann:0:42R0',
                pageIndex: 0,
                pageNumber: 1,
                text: 'visible imported text from Contents',
                subtype: 'FreeText',
                author: null,
                modifiedAt: null,
                color: '#ff00aa',
                uid: 'pdfjs-editor-42R0',
                annotationId: '42R0',
                source: 'editor',
                hasNote: false,
                markerRect,
            },
        ]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.listCommentSummaries()).toHaveLength(1);
        const [summary] = application.listCommentSummaries();
        expect(summary).toMatchObject({
            source: 'pdf',
            subtype: 'FreeText',
            text: 'visible imported text from Contents',
            annotationId: '42R',
            markerRect,
            hasNote: true,
        });

        const canonicalId = application.store.list()[0]?.identity.id;
        expect(canonicalId).toBeDefined();
        const reopened = new AnnotationApplication('document');
        const reopenedPdfSummary = {...summary!};
        delete reopenedPdfSummary.appAnnotationId;
        reopened.replaceFromDocumentSummaries([
            reopenedPdfSummary,
            {
                ...reopenedPdfSummary,
                id: '42R0',
                stableKey: 'ann:0:42R0',
                source: 'editor',
                uid: 'pdfjs-editor-42R0',
                annotationId: '42R0',
                hasNote: false,
            },
        ]);
        expect(reopened.store.list()).toHaveLength(1);
        expect(reopened.store.list()[0]?.identity.id).toBe(canonicalId);
    });

    it('imports a persisted Typewriter editor into the canonical store', () => {
        const application = new AnnotationApplication('document');

        application.replaceFromDocumentSummaries([{
            id: '45R',
            stableKey: 'ann:0:45R',
            pageIndex: 0,
            pageNumber: 1,
            text: 'visible persisted typewriter',
            subtype: 'Typewriter',
            author: null,
            modifiedAt: null,
            color: '#ff00aa',
            uid: 'pdfjs-editor-45R',
            annotationId: '45R',
            source: 'editor',
            hasNote: false,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.15,
            },
        }]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.store.list()[0]).toMatchObject({
            kind: 'text-box',
            text: 'visible persisted typewriter',
            identity: {pdfRef: '45R'},
        });
    });

    it('does not admit a transient FreeText editor from its generated id alone', () => {
        const application = new AnnotationApplication('document');

        application.replaceFromDocumentSummaries([{
            id: 'pdfjs_internal_editor_0',
            stableKey: 'ann:0:pdfjs_internal_editor_0',
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            subtype: 'FreeText',
            author: null,
            modifiedAt: null,
            color: '#ff00aa',
            uid: 'pdfjs_internal_editor_0',
            annotationId: 'pdfjs_internal_editor_0',
            source: 'editor',
            hasNote: false,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.15,
            },
        }]);

        expect(application.store.list()).toHaveLength(0);
    });

    it('leaves Stamp summaries to the canonical parser until image metadata is available', () => {
        const application = new AnnotationApplication('document');
        const stamp: IAnnotationCommentSummary = {
            source: 'pdf',
            id: '44R',
            stableKey: 'nm:placed-image-app-1',
            pageIndex: 2,
            pageNumber: 3,
            text: '',
            subtype: 'Stamp',
            author: null,
            createdAt: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: '44R',
            annotationName: 'placed-image-app-1',
            hasNote: false,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        };

        application.replaceFromDocumentSummaries([stamp]);

        expect(application.store.list()).toEqual([]);
    });

    it('projects a redone saved annotation as persisted, with its saved ref', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('anno_saved_highlight');
        application.store.createTextMarkup(textMarkup({
            identity: {id: annotationId},
            subtype: 'Highlight',
            persistedRevision: -1,
        }));
        application.store.markPersisted(application.store.beginSave(), [{
            annotationId,
            pdfRef: '31R',
        }]);
        const [saved] = application.listCommentSummaries();

        expect(application.store.undo()).toBe(true);
        expect(application.store.redo()).toBe(true);

        // The sidebar and every save projection read this: a redone annotation
        // the file still holds must project as the saved annotation it is, with
        // no rescan needed to repair it.
        const [redone] = application.listCommentSummaries();

        expect(saved).toMatchObject({
            source: 'pdf',
            annotationId: '31R',
            stableKey: 'ann:0:31R',
        });
        expect(redone).toMatchObject({
            appAnnotationId: annotationId,
            source: 'pdf',
            annotationId: '31R',
            stableKey: 'ann:0:31R',
        });
    });

    it('rejects a pre-existing identical markup when the new canonical annotation identity is missing', async () => {
        const application = new AnnotationApplication('document');
        application.store.createTextMarkup({
            kind: 'text-markup',
            identity: {id: asAnnotationId('anno_new_markup')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
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
            identity: {id: asAnnotationId('anno_new_markup')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
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
        application.store.markPersisted(session.frontier, [{
            annotationId: 'anno_new_markup',
            pdfRef: '9R',
        }]);
        expect(application.store.get(asAnnotationId('anno_new_markup'))).toEqual(expect.objectContaining({
            identity: expect.objectContaining({pdfRef: '9R'}),
            persistedRevision: 0,
        }));
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('converts a native canonical PDF object ref before storing a materialized identity', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('anno_native_markup');
        application.store.createTextMarkup(textMarkup({
            identity: {id: annotationId},
            persistedRevision: -1,
        }));

        const session = application.beginSave();
        application.recordMaterializedIdentityBinding(session, annotationId, '9 0 R');

        expect(session.materializedPdfRefs.get(annotationId)).toBe('9R');
    });

    it.each([
        'not-a-pdf-ref',
        '0 0 R',
        '9 0 Q',
        '9007199254740992 0 R',
    ])('rejects malformed native canonical PDF object ref %s', (pdfRef) => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('anno_malformed_native_markup');
        application.store.createTextMarkup(textMarkup({
            identity: {id: annotationId},
            persistedRevision: -1,
        }));

        expect(() => application.recordMaterializedIdentityBinding(
            application.beginSave(),
            annotationId,
            pdfRef,
        )).toThrow('Malformed materialized PDF ref');
    });

    it('verifies every text-markup QuadPoints region instead of its bounding rectangle', async () => {
        const application = new AnnotationApplication('document');
        application.store.createTextMarkup(textMarkup({
            identity: {
                id: asAnnotationId('anno_multi_quad'),
                pdfRef: '21R',
            },
            persistedRevision: -1,
            quadPoints: [
                {
                    left: 0.1,
                    top: 0.2,
                    width: 0.2,
                    height: 0.03,
                },
                {
                    left: 0.1,
                    top: 0.3,
                    width: 0.25,
                    height: 0.04,
                },
            ],
        }));
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
                    id: '21R',
                    subtype: 'Underline',
                    rect: [
                        10,
                        66,
                        35,
                        80,
                    ],
                    quadPoints: [
                        10,
                        80,
                        30,
                        80,
                        10,
                        77,
                        30,
                        77,
                        10,
                        70,
                        35,
                        70,
                        10,
                        66,
                        35,
                        66,
                    ],
                }]),
            })),
        })});

        await expect(application.verifySaveBytes(
            application.beginSave(),
            new Uint8Array([1]),
        )).resolves.toBeUndefined();
    });

    it('semantically verifies and binds a newly appended native FreeText note when PDF.js omits its annotation name', async () => {
        const application = new AnnotationApplication('document');
        const editorNote = note({
            identity: {id: asAnnotationId('anno_native_note')},
            createdAt: 1_781_000_000_000,
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            contents: 'Native note text',
        });
        application.store.createNote(editorNote);
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
        application.store.markPersisted(session.frontier, [{
            annotationId: editorNote.identity.id,
            pdfRef: '42R',
        }]);
        expect(application.store.get(asAnnotationId('anno_native_note')))
            .toEqual(expect.objectContaining({identity: expect.objectContaining({pdfRef: '42R'})}));
    });

    it('does not adopt a semantically identical pre-existing FreeText note as a new native append', async () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note({
            identity: {id: asAnnotationId('anno_native_note')},
            createdAt: 1_781_000_000_000,
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            contents: 'Native note text',
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
        application.store.createNote(note());
        const session = application.beginSave();
        application.store.updateNote(asAnnotationId('anno_test'), {contents: 'newer'});

        await expect(application.verifyAndAcknowledgeSave(
            session,
            new Uint8Array([1]),
            {reopen: async () => [note()]},
        )).rejects.toThrow('staleRevisionError');

        const current = application.store.get(asAnnotationId('anno_test'));
        expect(current).toMatchObject({
            revision: 1,
            persistedRevision: -1,
            contents: 'newer',
        });
        expect(application.beginSave().plan.expected).toMatchObject([{
            revision: 1,
            contents: 'newer',
        }]);
    });

    it('verifies deletion of an annotation from a removed trailing page without opening that page', async () => {
        const application = new AnnotationApplication('document');
        application.store.replaceFromDocument([note({
            pageIndex: 1,
            persistedRevision: 0,
        })], []);
        application.store.delete(asAnnotationId('anno_test'));
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
        application.store.createNote(note());
        application.store.updateNote(asAnnotationId('anno_test'), {contents: '\u200Bhello\uFEFF'});
        application.store.delete(asAnnotationId('anno_test'));
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({
            deleted: true,
            contents: 'hello',
        });
        expect(application.store.undo()).toBe(true);
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({
            deleted: false,
            contents: 'hello',
        });
        expect(application.store.redo()).toBe(true);
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({deleted: true});
    });

    it('replaces overlapping markup in one observable and undoable Store command', () => {
        const application = new AnnotationApplication('document');
        const existing = textMarkup();
        application.store.replaceFromDocument([existing], []);
        let emissions = 0;
        application.store.subscribe(() => {
            emissions += 1;
        });
        emissions = 0;

        const projection = application.store.applyTextMarkupSelection({
            kind: 'text-markup',
            identity: {id: asAnnotationId('new-underline')},
            pageIndex: 0,
            subtype: 'Underline',
            contents: '',
            quadPoints: [{
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
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        }, [{
            annotationId: existing.identity.id,
            observedQuadPoints: existing.quadPoints,
        }]);

        expect(emissions).toBe(1);
        expect(projection.replacements).toHaveLength(1);
        expect(projection.replacements[0]).toMatchObject({
            annotationId: existing.identity.id,
            deleted: false,
        });
        expect(projection.replacements[0]?.quadPoints).toHaveLength(2);
        expect(projection.replacements[0]?.quadPoints[0]).toEqual({
            left: 0.1,
            top: 0.2,
            width: 0.1,
            height: 0.03,
        });
        expect(projection.replacements[0]?.quadPoints[1]?.left).toBeCloseTo(0.3);
        expect(projection.replacements[0]?.quadPoints[1]?.width).toBeCloseTo(0.2);
        expect(application.store.list()).toHaveLength(2);

        expect(application.store.undo()).toBe(true);
        expect(application.store.list()).toEqual([existing]);
        expect(application.store.redo()).toBe(true);
        expect(application.store.list()).toHaveLength(2);
    });

    it('binds a created editor to its canonical markup without duplicate legacy ingestion', () => {
        const application = new AnnotationApplication('document');
        const projection = application.store.applyTextMarkupSelection({
            kind: 'text-markup',
            identity: {id: asAnnotationId('new-highlight')},
            pageIndex: 0,
            subtype: 'Highlight',
            contents: '',
            quadPoints: [{
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
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        }, []);
        const summary = {
            appAnnotationId: projection.created.identity.id,
            id: 'editor-1',
            stableKey: 'ann:0:editor-1' as const,
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
            markerRect: projection.created.quadPoints[0]!,
        };

        application.replaceFromDocumentSummaries([summary]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.annotationIdForSummary(summary)).toBe(projection.created.identity.id);
    });

    it('keeps a locally created note saveable after its own read model is ingested again', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note({identity: {id: asAnnotationId('anno_local_note')}}));

        application.replaceFromDocumentSummaries(application.listCommentSummaries());

        expect(application.store.list()).toHaveLength(1);
        expect(() => application.beginSave()).not.toThrow();
    });

    it('rejects reopen results with stale text or geometry', async () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note());
        const session = application.beginSave();
        await expect(application.verifyAndAcknowledgeSave(session, new Uint8Array([1]), {reopen: async () => [note({contents: 'stale'})]})).rejects.toThrow('contents mismatch');
    });

    it('rejects reopen results with stale text-box contents or geometry', async () => {
        const application = new AnnotationApplication('document');
        const expected = application.store.createTextBox(textBox());
        const session = application.beginSave();
        const staleTextBox = textBox({
            identity: expected.identity,
            text: 'stale text',
            rect: {
                left: 0.11,
                top: 0.2,
                width: 0.3,
                height: 0.15,
            },
        });
        const staleGeometryTextBox = textBox({
            identity: expected.identity,
            rect: {
                left: 0.11,
                top: 0.2,
                width: 0.3,
                height: 0.15,
            },
        });
        await expect(application.verifyAndAcknowledgeSave(session, new Uint8Array([1]), {reopen: async () => [staleTextBox]})).rejects.toThrow('text-box contents mismatch');
        await expect(application.verifyAndAcknowledgeSave(session, new Uint8Array([1]), {reopen: async () => [staleGeometryTextBox]})).rejects.toThrow('text-box rect mismatch');
    });

    it('keeps summary-adapter omissions until the canonical parser can replace them', () => {
        const application = new AnnotationApplication('document');
        const shapeEntity = toCanonicalShapeEntity(shape({annotationId: '12R'}), asAnnotationId('shape-summary-preserved'));
        const imageEntity = placedImage();
        const foreign = {
            pageIndex: 0,
            subtype: 'Widget',
            name: null,
            objectNumber: 91,
            generationNumber: 0,
            reason: 'not app-owned',
        };
        application.store.replaceFromDocument(
            [
                shapeEntity,
                imageEntity,
            ],
            [foreign],
        );

        application.replaceFromDocumentSummaries([{
            id: 'note-1',
            stableKey: 'ann:0:note-1',
            pageIndex: 0,
            pageNumber: 1,
            text: 'summary note',
            subtype: 'Text',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: null,
            source: 'pdf',
            hasNote: true,
            markerRect: {
                left: 0.2,
                top: 0.3,
                width: 0.02,
                height: 0.02,
            },
        }]);

        expect(application.store.get(shapeEntity.identity.id)).toMatchObject({kind: 'shape'});
        expect(application.store.get(imageEntity.identity.id)).toMatchObject({kind: 'placed-image'});
        expect(application.store.foreign).toEqual([foreign]);
        expect(application.store.list()).toHaveLength(3);
    });

    it('publishes shape undo and redo to subscribers from the single canonical history command', () => {
        const application = new AnnotationApplication('document');
        const projected: IShapeAnnotation[][] = [];
        application.store.subscribe(() => {
            projected.push(application.store.list()
                .filter((entity): entity is Extract<typeof entity, {kind: 'shape'}> => entity.kind === 'shape')
                .map(entity => application.toLegacyShape(entity)));
        });

        const created = toCanonicalShapeEntity(shape(), asAnnotationId('shape-1'));
        application.store.createShape(created);
        const annotationId = created.identity.id;

        expect(annotationId).not.toBeNull();
        expect(projected.at(-1)).toHaveLength(1);
        expect(application.store.undo()).toBe(true);
        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(projected.at(-1)).toEqual([]);
        expect(application.store.redo()).toBe(true);
        expect(application.store.get(annotationId!)).toMatchObject({kind: 'shape'});
        expect(projected.at(-1)).toHaveLength(1);
    });

    it('remaps surviving annotation and shape identities through a page-tree delta', () => {
        const application = new AnnotationApplication('document');
        application.store.createNote(note({pageIndex: 0}));
        const createdShape = toCanonicalShapeEntity(shape({pageIndex: 2}), asAnnotationId('shape-1'));
        application.store.createShape(createdShape);
        const shapeId = createdShape.identity.id;

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
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        });
    });
});
