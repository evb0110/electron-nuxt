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

    it('rejects reopen results with stale text or geometry', async () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note());
        const session = application.beginSave();
        await expect(application.verifyAndAcknowledgeSave(session, new Uint8Array([1]), {reopen: async () => [note({text: 'stale'})]})).rejects.toThrow('text mismatch');
    });

    it('rolls canonical shape creation back when the projection executor fails', () => {
        const application = new AnnotationApplication('document');

        expect(() => application.createShapeProjected({
            kind: 'shape',
            pageIndex: 0,
            createdAt: 1,
            modifiedAt: 1,
            author: null,
            geometry: shape(),
        }, () => {
            throw new Error('projection failed');
        })).toThrow('projection failed');

        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(application.store.canUndo).toBe(false);
    });

    it('projects shape undo and redo from the single canonical history command', () => {
        const application = new AnnotationApplication('document');
        const projected: IShapeAnnotation[] = [];
        const applyProjection = (next: {geometry: Readonly<IShapeAnnotation>} | null) => {
            projected.splice(0, projected.length, ...(next ? [structuredClone(next.geometry)] : []));
        };

        application.createShapeProjected({
            kind: 'shape',
            pageIndex: 0,
            createdAt: 1,
            modifiedAt: 1,
            author: null,
            geometry: shape(),
        }, applyProjection);
        const annotationId = application.annotationIdForShape(shape());

        expect(annotationId).not.toBeNull();
        expect(projected).toHaveLength(1);
        expect(application.undo()).toBe(true);
        expect(application.store.list({includeDeleted: true})).toEqual([]);
        expect(projected).toEqual([]);
        expect(application.redo()).toBe(true);
        expect(application.store.get(annotationId!)).toMatchObject({kind: 'shape'});
        expect(projected).toHaveLength(1);
    });

    it('remaps surviving annotation and shape identities through a page-tree delta', () => {
        const application = new AnnotationApplication('document');
        application.store.createStickyNote(note({pageIndex: 0}));
        application.createShapeProjected({
            kind: 'shape',
            pageIndex: 2,
            createdAt: 1,
            modifiedAt: 1,
            author: null,
            geometry: shape({pageIndex: 2}),
        }, () => undefined);
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
