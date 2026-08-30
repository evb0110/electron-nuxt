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

function placedImageSummary(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
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
        application.store.delete(annotationId);
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
        application.reconcilePdfjsEditorPresence(
            new Set(['pdfjs-editor-1']),
            {changedExternalIds: new Set(['pdfjs-editor-2'])},
        );
        expect(application.store.get(transientId)?.deleted).toBe(true);
        application.reconcilePdfjsEditorPresence(new Set([
            'pdfjs-editor-1',
            'pdfjs-editor-2',
        ]));
        expect(application.store.get(transientId)?.deleted).toBe(false);
    });

    it('imports an app-owned no-note Stamp as a placed image and preserves its NM across reopen', () => {
        const application = new AnnotationApplication('document');
        const imported = placedImageSummary();

        application.ingestLegacySummaries([imported]);

        const [entity] = application.store.list();
        expect(entity).toMatchObject({
            kind: 'placed-image',
            pageIndex: 2,
            identity: {
                pdfName: 'placed-image-app-1',
                pdfRef: '44R',
            },
        });

        const [projected] = application.listCommentSummaries();
        expect(projected).toMatchObject({
            source: 'pdf',
            appAnnotationId: entity?.identity.id,
            annotationId: '44R',
            annotationName: 'placed-image-app-1',
            subtype: 'Stamp',
            hasNote: false,
            markerRect: imported.markerRect,
        });
        expect(application.projectSummaries([{
            ...projected!,
            hasNote: true,
        }])[0]?.hasNote).toBe(false);

        const reopened = new AnnotationApplication('document');
        const reopenedSummary = placedImageSummary({
            id: '91R',
            annotationId: '91R',
            markerRect: {
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.5,
            },
        });
        reopened.ingestLegacySummaries([reopenedSummary]);

        const [reopenedEntity] = reopened.store.list();
        if (!reopenedEntity || reopenedEntity.kind !== 'placed-image') {
            throw new Error('Expected a placed-image entity after reopen');
        }
        expect(reopenedEntity.identity.id).toBe(entity?.identity.id);
        expect(reopenedEntity?.identity.pdfRef).toBe('91R');
        expect(reopenedEntity.rect).toEqual(reopenedSummary.markerRect);
        expect(reopened.annotationIdForSummary(reopenedSummary))
            .toBe(reopenedEntity?.identity.id);
        expect(reopened.store.hasChangesSinceSavedBaseline()).toBe(false);
    });

    it('keeps sticky-note projection note-bearing', () => {
        const application = new AnnotationApplication('document');
        application.store.import(note());
        const [summary] = application.listCommentSummaries();

        expect(application.projectSummaries([{
            ...summary!,
            hasNote: false,
        }])[0]?.hasNote).toBe(true);
    });

    it('imports a persisted non-point FreeText editor into the canonical store', () => {
        const application = new AnnotationApplication('document');

        application.ingestLegacySummaries([{
            id: '44R',
            stableKey: 'src:editor:0:44R',
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
            kind: 'sticky-note',
            text: 'visible imported text',
            pageIndex: 0,
            identity: {
                pdfRef: '44R',
                pdfjsUid: 'pdfjs-editor-44R',
                elementId: '44R',
            },
        });
    });

    it('imports a persisted Typewriter editor into the canonical store', () => {
        const application = new AnnotationApplication('document');

        application.ingestLegacySummaries([{
            id: '45R',
            stableKey: 'src:editor:0:45R',
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
            kind: 'sticky-note',
            text: 'visible persisted typewriter',
            identity: {
                pdfRef: '45R',
                pdfjsUid: 'pdfjs-editor-45R',
                elementId: '45R',
            },
        });
    });

    it('does not admit a transient FreeText editor from its generated id alone', () => {
        const application = new AnnotationApplication('document');

        application.ingestLegacySummaries([{
            id: 'pdfjs_internal_editor_0',
            stableKey: 'src:editor:0:pdfjs_internal_editor_0',
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

    it('fails closed when one PDF snapshot repeats a placed-image NM', () => {
        const application = new AnnotationApplication('document');

        application.ingestLegacySummaries([
            placedImageSummary(),
            placedImageSummary({
                id: '45R',
                annotationId: '45R',
            }),
        ]);

        expect(application.store.list()).toEqual([]);
        expect(application.listCommentSummaries()).toEqual([]);
        expect(application.legacyIdentityConflicts.size).toBe(2);
    });

    it('ignores third-party Stamp summaries without the app-owned placed-image NM prefix', () => {
        const application = new AnnotationApplication('document');

        application.ingestLegacySummaries([placedImageSummary({
            annotationName: 'Approved',
            stableKey: 'nm:Approved',
        })]);

        expect(application.store.list()).toEqual([]);
    });

    it('fails closed when a placed-image ref disagrees with its imported NM', () => {
        const application = new AnnotationApplication('document');
        application.ingestLegacySummaries([placedImageSummary()]);
        const [projected] = application.listCommentSummaries();

        expect(application.annotationIdForSummary({
            ...projected!,
            id: '99R',
            annotationId: '99R',
        })).toBeNull();
    });

    it('does not rebind a retired PDF ref from a restored editor summary', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('saved-highlight-undo');
        application.store.import(textMarkup({
            identity: {
                id: annotationId,
                pdfRef: '12R0',
                pdfjsUid: 'highlight-editor-1',
            },
            persistedRevision: 0,
        }));

        application.store.delete(annotationId);
        application.store.acknowledgeSave(application.store.beginSave());
        expect(application.store.get(annotationId)).toMatchObject({
            deleted: true,
            identity: {id: annotationId},
            persistedRevision: -1,
        });

        expect(application.store.undo()).toBe(true);
        expect(application.store.get(annotationId)).toMatchObject({
            deleted: false,
            identity: {id: annotationId},
            persistedRevision: -1,
        });
        expect(application.store.get(annotationId)?.identity).not.toHaveProperty('pdfRef');

        application.ingestLegacySummaries([{
            ...application.listCommentSummaries()[0]!,
            source: 'editor',
            annotationId: '12R0',
        }]);

        expect(application.store.get(annotationId)?.identity).not.toHaveProperty('pdfRef');

        application.ingestLegacySummaries([{
            ...application.listCommentSummaries()[0]!,
            source: 'pdf',
            annotationId: '13R0',
        }]);

        expect(application.store.get(annotationId)?.identity.pdfRef).toBe('13R0');
    });

    it('projects a redone saved annotation as persisted, with its saved ref', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('anno_saved_highlight');
        application.store.createTextMarkup(textMarkup({
            identity: {
                id: annotationId,
                pdfjsUid: 'editor-uid-1',
            },
            subtype: 'Highlight',
            persistedRevision: -1,
        }));
        application.store.acknowledgeSave(application.store.beginSave(), new Map([[
            annotationId,
            '31R',
        ]]));
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

    it('converts a native canonical PDF object ref before storing a materialized identity', () => {
        const application = new AnnotationApplication('document');
        const annotationId = asAnnotationId('anno_native_markup');
        application.store.createTextMarkup(textMarkup({
            identity: {
                id: annotationId,
                elementId: 'pdfjs_internal_editor_native_markup',
            },
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
            geometry: [
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
        application.store.setNoteText(asAnnotationId('anno_test'), 'newer');

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
        application.store.createStickyNote(note());
        application.store.setNoteText(asAnnotationId('anno_test'), '\u200Bhello\uFEFF');
        application.store.delete(asAnnotationId('anno_test'));
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({
            deleted: true,
            text: 'hello',
        });
        expect(application.store.undo()).toBe(true);
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({
            deleted: false,
            text: 'hello',
        });
        expect(application.store.redo()).toBe(true);
        expect(application.store.get(asAnnotationId('anno_test'))).toMatchObject({deleted: true});
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

        const projection = application.store.applyTextMarkupSelection({
            kind: 'text-markup',
            identity: {id: asAnnotationId('new-underline')},
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
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        }, [{
            annotationId: existing.identity.id,
            observedGeometry: existing.geometry,
        }]);

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
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        }, []);
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

        application.store.bindIdentity({
            annotationId: projection.created.identity.id,
            expectedRevision: projection.created.revision,
            bindings: {
                pdfjsUid: summary.uid!,
                elementId: summary.id,
            },
        });
        application.ingestLegacySummaries([summary]);

        expect(application.store.list()).toHaveLength(1);
        expect(application.annotationIdForSummary(summary)).toBe(projection.created.identity.id);
    });

    it('keeps a locally created note saveable after its own read model is ingested again', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note({identity: {id: asAnnotationId('anno_local_note')}}));

        application.ingestLegacySummaries(application.listCommentSummaries());

        expect(application.store.list()).toHaveLength(1);
        expect(() => application.beginSave()).not.toThrow();
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
        expect(application.store.undo()).toBe(true);
        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(projected.at(-1)).toEqual([]);
        expect(application.store.redo()).toBe(true);
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
