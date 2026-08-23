import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    ILinkAnnotation,
} from '@app/types/annotations';
import { useAnnotationIdentity } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationIdentity';
import type { IPdfPageAnnotationBundle } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import type { TPdfSource } from '@app/types/pdfUi';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';
import { createBrowserDocumentRef } from '@app/platform/browser/browserDocumentRefs';
import { resolveAnnotationSnapshotDocumentIdentity } from '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession';

function resolvePdfAnnotationNameReadLimits(tier: 'low' | 'medium') {
    const policy = resolveOpenPathSecondaryPerformancePolicy(resolvePerformanceProfile({ tier }));
    return {
        eagerMaxBytes: policy.eagerAnnotationNameReadMaxBytes,
        interactiveMaxBytes: policy.interactiveAnnotationNameReadMaxBytes,
    };
}

const {
    collectPdfAnnotationNamesByPage,
    leasePdfDocumentPage,
    loadPdfPageAnnotations,
} = vi.hoisted(() => {
    const mock = vi.fn<
        (
            _doc: unknown,
            _pageNumber: number,
            _annotationNames?: ReadonlyMap<string, string> | null,
            _options?: {leasePage?: (doc: unknown, page: number) => Promise<unknown>},
        ) => Promise<IPdfPageAnnotationBundle | null>
    >();
    return {
        collectPdfAnnotationNamesByPage: vi.fn(async () => new Map<number, Map<string, string>>()),
        leasePdfDocumentPage: vi.fn(async () => ({
            page: {},
            release: vi.fn(),
        })),
        loadPdfPageAnnotations: mock,
    };
});

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    default: {},
    AnnotationEditorParamsType: {},
    AnnotationEditorType: {
        FREETEXT: 3,
        HIGHLIGHT: 9,
        STAMP: 13,
    },
    PixelsPerInch: {PDF_TO_CSS_UNITS: 96 / 72},
    assertPdfjsRuntimeCompatibility: vi.fn(),
    PDFDateString: {toDateObject: vi.fn(() => null)},
}));
vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));
vi.mock('@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource', () => ({leasePdfDocumentPage}));
vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage', () => (
    {collectPdfAnnotationNamesByPage}
));

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/loadPdfPageAnnotations', async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
        ...actual,
        loadPdfPageAnnotations,
    };
});

beforeEach(() => {
    vi.resetModules();
    loadPdfPageAnnotations.mockReset();
});

async function readInventoryCaps() {
    const syncModule = await import('@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationSync');
    return {
        pageCap: syncModule.MAX_BACKGROUND_PDF_ANNOTATION_PAGES,
        recordCap: syncModule.MAX_BACKGROUND_PDF_ANNOTATION_RECORDS,
    };
}

async function spyOnAnnotationWarnings() {
    const { BrowserLogger } = await import('@app/utils/browserLogger');
    return vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
}

function createEmptyPageBundle(): IPdfPageAnnotationBundle {
    return {
        annotations: [],
        pageRotation: 0,
        pageView: [
            0,
            0,
            100,
            100,
        ],
    };
}

function createLinkPageBundle(pageNumber: number, count: number): IPdfPageAnnotationBundle {
    return {
        annotations: Array.from({ length: count }, (_unused, index) => ({
            id: `link-${pageNumber}-${index}`,
            subtype: 'Link',
            url: `https://example.test/${pageNumber}/${index}`,
            rect: [
                0,
                0,
                10,
                10,
            ],
        })),
        pageRotation: 0,
        pageView: [
            0,
            0,
            100,
            100,
        ],
    };
}

async function withAnnotationSyncScope<T>(run: () => Promise<T>) {
    const scope = effectScope();
    try {
        return await scope.run(run);
    } finally {
        scope.stop();
    }
}

function createMarkupSubtypeStore() {
    const colorOverrides = new Map<string, string>();
    return {
        colorOverrides,
        markupSubtype: {
            resolveEditorMarkupSubtypeOverride: vi.fn(() => null),
            resolveEditorSubtypeFromPresentation: vi.fn(() => null),
            resolveEditorMarkupSubtypeColor: vi.fn(() => '#ef4444'),
            rememberMarkupSubtypeColorOverride: vi.fn((
                annotationId: string | null | undefined,
                color: string | null | undefined,
            ) => {
                if (!annotationId || !color) {
                    return;
                }
                colorOverrides.set(annotationId, color);
            }),
            forgetMarkupSubtypeOverride: vi.fn((annotationId: string | null | undefined) => {
                if (!annotationId) {
                    return;
                }
                colorOverrides.delete(annotationId);
            }),
            clearOverrides: vi.fn(() => {
                colorOverrides.clear();
            }),
        },
    };
}

async function createSyncHarness(options: {
    annotationCommentsCache?: Ref<IAnnotationCommentSummary[]>;
    annotationUiManager?: ReturnType<typeof shallowRef>;
    documentIdentity?: ReturnType<typeof ref<string>>;
    documentRevisionToken?: ReturnType<typeof ref<string>>;
    getPdfSourceByteSize?: () => number | null;
    isPdfSourceBlob?: () => boolean;
    limits?: ReturnType<typeof resolvePdfAnnotationNameReadLimits>;
    pdfDocument?: object;
    setAnnotations?: ReturnType<typeof vi.fn>;
    setInventoryCompleteness?: ReturnType<typeof vi.fn>;
    setLinkAnnotations?: ReturnType<typeof vi.fn>;
    numPages?: ReturnType<typeof ref<number>>;
    currentPage?: ReturnType<typeof ref<number>>;
} = {}) {
    const annotationCommentsCache = options.annotationCommentsCache ?? ref<IAnnotationCommentSummary[]>([]);
    const identity = useAnnotationIdentity(annotationCommentsCache);
    const markupSubtypeStore = createMarkupSubtypeStore();
    const setAnnotations = options.setAnnotations ?? vi.fn((comments: IAnnotationCommentSummary[]) => {
        annotationCommentsCache.value = comments;
        return comments;
    });
    const setLinkAnnotations = options.setLinkAnnotations ?? vi.fn((_links: ILinkAnnotation[]) => {});
    const setInventoryCompleteness = options.setInventoryCompleteness
        ?? vi.fn((_completeness: IAnnotationInventoryCompleteness | null) => {});
    const { useAnnotationSync } = await import('@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationSync');
    const textMarkupPresentation = {notify: vi.fn()};
    const sync = useAnnotationSync({
        pdfDocument: shallowRef(options.pdfDocument ?? {}),
        documentIdentity: options.documentIdentity ?? ref('document'),
        documentRevisionToken: options.documentRevisionToken,
        numPages: options.numPages ?? ref(1),
        currentPage: options.currentPage ?? ref(1),
        annotationUiManager: options.annotationUiManager ?? shallowRef(null),
        authorName: ref(null),
        getIdentity: () => identity,
        getMarkupSubtype: () => markupSubtypeStore.markupSubtype,
        getStore: () => ({
            setAnnotations,
            setLinkAnnotations,
            setActiveKey: vi.fn(),
            setInventoryCompleteness,
        }),
        syncInlineCommentIndicators: vi.fn(),
        textMarkupPresentation,
        getAnnotationNameReadLimits: () => options.limits ?? resolvePdfAnnotationNameReadLimits('medium'),
        getPdfSourceByteSize: options.getPdfSourceByteSize ?? (() => null),
        isPdfSourceBlob: options.isPdfSourceBlob ?? (() => false),
    } as never);
    return {
        annotationCommentsCache,
        ...markupSubtypeStore,
        setAnnotations,
        setInventoryCompleteness,
        setLinkAnnotations,
        sync,
        textMarkupPresentation,
    };
}

describe('useAnnotationSync', () => {
    it('gives pathless Blob instances distinct stable snapshot identities', () => {
        const lastModified = 1_735_689_600_000;
        const first = new File(
            [Uint8Array.of(1, 2, 3, 4)],
            'shared-name.pdf',
            {lastModified},
        );
        const second = new File(
            [Uint8Array.of(5, 6, 7, 8)],
            'shared-name.pdf',
            {lastModified},
        );
        const resolveIdentity = (source: TPdfSource | null) => resolveAnnotationSnapshotDocumentIdentity({
            originalPath: null,
            workingCopyPath: null,
            source,
        });

        const firstIdentity = resolveIdentity(first);

        expect(resolveIdentity(first)).toBe(firstIdentity);
        expect(resolveIdentity(second)).not.toBe(firstIdentity);
        expect(resolveIdentity(null)).toBe('no-document');
        expect(resolveAnnotationSnapshotDocumentIdentity({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            source: first,
        })).toBe('source:/documents/original.pdf');
        expect(resolveAnnotationSnapshotDocumentIdentity({
            originalPath: null,
            workingCopyPath: '/managed/working.pdf',
            source: first,
        })).toBe('path:/managed/working.pdf');
        expect(resolveIdentity({
            kind: 'path',
            path: '/documents/source.pdf',
            size: 4,
        })).toBe('path:/documents/source.pdf');
    });

    it('isolates same-metadata handle records while reusing a reopened record snapshot', async () => {
        loadPdfPageAnnotations
            .mockResolvedValueOnce({
                annotations: [
                    {
                        id: 'document-a-comment',
                        subtype: 'FreeText',
                        contentsObj: {str: 'Document A note'},
                        rect: [
                            10,
                            10,
                            20,
                            20,
                        ],
                    },
                    {
                        id: 'document-a-link',
                        subtype: 'Link',
                        url: 'https://document-a.example',
                        rect: [
                            30,
                            30,
                            40,
                            40,
                        ],
                    },
                ],
                pageRotation: 0,
                pageView: [
                    0,
                    0,
                    100,
                    100,
                ],
            })
            .mockResolvedValueOnce({
                annotations: [],
                pageRotation: 0,
                pageView: [
                    0,
                    0,
                    100,
                    100,
                ],
            });

        const lastModified = 1_735_689_600_000;
        const documentAFile = new File(
            [Uint8Array.of(1, 2, 3, 4)],
            'shared-name.pdf',
            {lastModified},
        );
        const documentBFile = new File(
            [Uint8Array.of(5, 6, 7, 8)],
            'shared-name.pdf',
            {lastModified},
        );
        const documentAOriginalPath = createBrowserDocumentRef(documentAFile.name);
        const documentBOriginalPath = createBrowserDocumentRef(documentBFile.name);
        const documentAIdentity = resolveAnnotationSnapshotDocumentIdentity({
            originalPath: documentAOriginalPath,
            workingCopyPath: null,
            source: documentAFile,
        });
        const documentBIdentity = resolveAnnotationSnapshotDocumentIdentity({
            originalPath: documentBOriginalPath,
            workingCopyPath: null,
            source: documentBFile,
        });
        const sharedRevision = `handle:${documentAFile.size}:${documentAFile.lastModified}`;

        expect(documentBFile).toMatchObject({
            name: documentAFile.name,
            size: documentAFile.size,
            lastModified: documentAFile.lastModified,
        });
        expect(documentBOriginalPath).not.toBe(documentAOriginalPath);

        await withAnnotationSyncScope(async () => {
            const documentA = await createSyncHarness({
                documentIdentity: ref(documentAIdentity),
                documentRevisionToken: ref(sharedRevision),
                pdfDocument: {},
            });
            await documentA.sync.syncAnnotationComments();

            expect(documentA.setAnnotations).toHaveBeenLastCalledWith(
                [expect.objectContaining({annotationId: 'document-a-comment'})],
                expect.any(Object),
            );
            expect(documentA.setLinkAnnotations).toHaveBeenLastCalledWith(
                [expect.objectContaining({id: 'document-a-link'})],
            );

            const reopenedDocumentA = await createSyncHarness({
                documentIdentity: ref(resolveAnnotationSnapshotDocumentIdentity({
                    originalPath: documentAOriginalPath,
                    workingCopyPath: null,
                    source: documentAFile,
                })),
                documentRevisionToken: ref(sharedRevision),
                pdfDocument: {},
            });
            await reopenedDocumentA.sync.syncAnnotationComments();

            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(1);
            expect(reopenedDocumentA.setAnnotations).toHaveBeenLastCalledWith(
                [expect.objectContaining({annotationId: 'document-a-comment'})],
                expect.any(Object),
            );
            expect(reopenedDocumentA.setLinkAnnotations).toHaveBeenLastCalledWith(
                [expect.objectContaining({id: 'document-a-link'})],
            );

            const documentB = await createSyncHarness({
                documentIdentity: ref(documentBIdentity),
                documentRevisionToken: ref(sharedRevision),
                pdfDocument: {},
            });
            await documentB.sync.syncAnnotationComments();

            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(2);
            expect(documentB.setAnnotations).toHaveBeenLastCalledWith([], expect.any(Object));
            expect(documentB.setLinkAnnotations).toHaveBeenLastCalledWith([]);
        });
    });

    it('uses inclusive 16 MiB normal and 4 MiB constrained eager boundaries', async () => {
        expect(resolvePdfAnnotationNameReadLimits('medium')).toEqual({
            eagerMaxBytes: 16 * 1024 * 1024,
            interactiveMaxBytes: 64 * 1024 * 1024,
        });
        expect(resolvePdfAnnotationNameReadLimits('low')).toEqual({
            eagerMaxBytes: 4 * 1024 * 1024,
            interactiveMaxBytes: 16 * 1024 * 1024,
        });

        for (const tier of [
            'medium',
            'low',
        ] as const) {
            collectPdfAnnotationNamesByPage.mockClear();
            loadPdfPageAnnotations.mockResolvedValue({
                annotations: [],
                pageRotation: 0,
                pageView: [
                    0,
                    0,
                    100,
                    100,
                ],
            });
            await withAnnotationSyncScope(async () => {
                const limits = resolvePdfAnnotationNameReadLimits(tier);
                const { sync } = await createSyncHarness({
                    documentIdentity: ref(`document-${tier}`),
                    limits,
                    getPdfSourceByteSize: () => limits.eagerMaxBytes,
                    isPdfSourceBlob: () => true,
                });

                await sync.syncAnnotationComments();
                expect(collectPdfAnnotationNamesByPage).toHaveBeenCalledOnce();
            });
        }
    });

    it('never starts eager annotation-name parsing for a path source', async () => {
        collectPdfAnnotationNamesByPage.mockClear();
        loadPdfPageAnnotations.mockResolvedValue({
            annotations: [],
            pageRotation: 0,
            pageView: [
                0,
                0,
                100,
                100,
            ],
        });

        await withAnnotationSyncScope(async () => {
            const { sync } = await createSyncHarness({
                documentIdentity: ref('path-document'),
                pdfDocument: {getData: vi.fn()},
                getPdfSourceByteSize: () => 1024,
            });

            await sync.syncAnnotationComments();
            expect(collectPdfAnnotationNamesByPage).not.toHaveBeenCalled();
        });
    });

    it('deduplicates interactive reconciliation and discards a stale revision result', async () => {
        let resolveNames!: (value: Map<number, Map<string, string>>) => void;
        collectPdfAnnotationNamesByPage.mockImplementationOnce(() => new Promise((resolve) => {
            resolveNames = resolve;
        }));
        loadPdfPageAnnotations.mockResolvedValue({
            annotations: [],
            pageRotation: 0,
            pageView: [
                0,
                0,
                100,
                100,
            ],
        });

        await withAnnotationSyncScope(async () => {
            const revision = ref('revision-1');
            const { sync } = await createSyncHarness({
                documentIdentity: ref('path-document'),
                documentRevisionToken: revision,
                getPdfSourceByteSize: () => 1024,
            });

            const first = sync.ensurePdfAnnotationNameReconciliation('annotations-ui-open');
            const second = sync.ensurePdfAnnotationNameReconciliation('existing-annotation-mutation');
            expect(second).toBe(first);
            await vi.waitFor(() => {
                expect(collectPdfAnnotationNamesByPage).toHaveBeenCalledOnce();
            });

            revision.value = 'revision-2';
            await nextTick();
            resolveNames(new Map());

            await expect(first).resolves.toBe('stale');
        });
    });

    it('keeps over-limit interactive reconciliation reference-based', async () => {
        collectPdfAnnotationNamesByPage.mockClear();
        loadPdfPageAnnotations.mockResolvedValue({
            annotations: [{
                id: '12R0',
                subtype: 'FreeText',
                contentsObj: {str: 'Persisted note'},
                rect: [
                    10,
                    10,
                    11,
                    11,
                ],
            }],
            pageRotation: 0,
            pageView: [
                0,
                0,
                100,
                100,
            ],
        });

        await withAnnotationSyncScope(async () => {
            const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
            const setAnnotations = vi.fn((comments: IAnnotationCommentSummary[]) => {
                annotationCommentsCache.value = comments;
                return comments;
            });
            const limits = resolvePdfAnnotationNameReadLimits('low');
            const { sync } = await createSyncHarness({
                annotationCommentsCache,
                documentIdentity: ref('large-path-document'),
                limits,
                getPdfSourceByteSize: () => limits.interactiveMaxBytes + 1,
                setAnnotations,
            });

            await sync.syncAnnotationComments();
            await expect(sync.ensurePdfAnnotationNameReconciliation('annotations-ui-open'))
                .resolves.toBe('skipped-over-limit');
            expect(collectPdfAnnotationNamesByPage).not.toHaveBeenCalled();
            expect(annotationCommentsCache.value[0]).toMatchObject({
                annotationId: '12R0',
                text: 'Persisted note',
            });
            expect(annotationCommentsCache.value[0]?.annotationName).toBeNull();
        });
    });

    it('remembers the color-preserved underline summary for zoom rerender presentation sync', async () => {
        loadPdfPageAnnotations.mockResolvedValue({
            annotations: [{
                id: '12R0',
                subtype: 'Underline',
                color: '#ef4444',
                rect: [
                    10,
                    10,
                    60,
                    20,
                ],
            }],
            pageRotation: 0,
            pageView: [
                0,
                0,
                100,
                100,
            ],
        });

        await withAnnotationSyncScope(async () => {
            const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
            const appliedColor = '#22c55e';
            const documentIdentity = ref('document-1');
            const setAnnotations = vi.fn((comments: IAnnotationCommentSummary[]) => {
                const appliedComments = comments.map(comment => ({
                    ...comment,
                    color: comment.annotationId === '12R0' ? appliedColor : comment.color,
                    colorEdited: comment.annotationId === '12R0' ? true : comment.colorEdited,
                }));
                annotationCommentsCache.value = appliedComments;
                return appliedComments;
            });
            const {
                colorOverrides,
                sync,
                textMarkupPresentation,
            } = await createSyncHarness({
                annotationCommentsCache,
                documentIdentity,
                setAnnotations,
            });

            await sync.syncAnnotationComments();

            const inventoryLease = loadPdfPageAnnotations.mock.calls[0]?.[3]?.leasePage;
            await inventoryLease?.({}, 1);
            expect(leasePdfDocumentPage).toHaveBeenCalledWith(
                {},
                1,
                'transient-background',
            );

            expect(setAnnotations).toHaveBeenCalledWith(
                [expect.objectContaining({
                    annotationId: '12R0',
                    color: '#ef4444',
                    subtype: 'Underline',
                })],
                {
                    adoptAsSavedBaseline: false,
                    reconcileMissingTransient: false,
                },
            );

            await sync.syncAnnotationComments();
            expect(setAnnotations).toHaveBeenLastCalledWith(
                expect.any(Array),
                {
                    adoptAsSavedBaseline: false,
                    reconcileMissingTransient: false,
                },
            );

            documentIdentity.value = 'document-1-working-copy';
            await nextTick();
            await sync.syncAnnotationComments();
            expect(setAnnotations).toHaveBeenLastCalledWith(
                expect.any(Array),
                {
                    adoptAsSavedBaseline: false,
                    reconcileMissingTransient: false,
                },
            );
            expect(colorOverrides.get('12R0')).toBe(appliedColor);
            expect(textMarkupPresentation.notify).toHaveBeenCalledTimes(3);
            expect(textMarkupPresentation.notify).toHaveBeenLastCalledWith({kind: 'editors-changed'});
        });
    });

    it('does not adopt a post-open user editor when the first authoritative sync follows degraded hydration', async () => {
        loadPdfPageAnnotations.mockResolvedValue({
            annotations: [],
            pageRotation: 0,
            pageView: [
                0,
                0,
                100,
                100,
            ],
        });

        await withAnnotationSyncScope(async () => {
            const annotationCommentsCache = ref<IAnnotationCommentSummary[]>([]);
            const annotationUiManager = shallowRef<null | {getEditors: () => Set<object>}>(null);
            const setAnnotations = vi.fn((comments: IAnnotationCommentSummary[]) => {
                annotationCommentsCache.value = comments;
                return comments;
            });
            const { sync } = await createSyncHarness({
                annotationCommentsCache,
                annotationUiManager,
                documentIdentity: ref('document-chronology'),
                setAnnotations,
            });

            await sync.syncAnnotationComments();

            const userEditor = {
                id: 'post-open-user-editor',
                parentPageIndex: 0,
            };
            sync.trackedCreatedEditors.add(userEditor);
            annotationUiManager.value = {getEditors: () => new Set([userEditor])};
            await sync.syncAnnotationComments();

            expect(setAnnotations).toHaveBeenLastCalledWith(
                [expect.objectContaining({id: 'editor:0:post-open-user-editor'})],
                {
                    adoptAsSavedBaseline: false,
                    reconcileMissingTransient: true,
                },
            );
        });
    });
});

describe('useAnnotationSync inventory completeness', () => {
    it('reports a complete inventory without warning when every page is read', async () => {
        loadPdfPageAnnotations.mockResolvedValue(createEmptyPageBundle());

        await withAnnotationSyncScope(async () => {
            const warn = await spyOnAnnotationWarnings();
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('complete-document'),
                numPages: ref(3),
            });

            await sync.syncAnnotationComments();

            expect(setInventoryCompleteness).toHaveBeenLastCalledWith({
                complete: true,
                omissions: [],
                scannedPageCount: 3,
                totalPageCount: 3,
                failedPageCount: 0,
            });
            expect(warn).not.toHaveBeenCalledWith(
                'annotations',
                'Background annotation inventory is incomplete',
                expect.anything(),
            );
        });
    });

    it('flags and warns when the page cap truncates the scan', async () => {
        loadPdfPageAnnotations.mockResolvedValue(createEmptyPageBundle());

        await withAnnotationSyncScope(async () => {
            const { pageCap } = await readInventoryCaps();
            // One page past the cap: the scan has to stop on the boundary and
            // report the page it never reached.
            const totalPages = pageCap + 1;
            const warn = await spyOnAnnotationWarnings();
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('capped-document'),
                numPages: ref(totalPages),
            });

            await sync.syncAnnotationComments();

            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(pageCap);
            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                omissions: ['page-cap'],
                scannedPageCount: pageCap,
                totalPageCount: totalPages,
                failedPageCount: 0,
            }));
            expect(warn).toHaveBeenCalledWith(
                'annotations',
                'Background annotation inventory is incomplete',
                expect.objectContaining({ omissions: ['page-cap'] }),
            );
        });
    });

    it('flags and warns when the record cap truncates the scan', async () => {
        const { recordCap } = await readInventoryCaps();
        // Size the fixture so the cap trips on the third page: two pages stay
        // under it, and the third crosses it with pages still unread.
        const cappedOnPage = 3;
        const linksPerPage = Math.ceil(recordCap / cappedOnPage);
        expect(linksPerPage * (cappedOnPage - 1)).toBeLessThan(recordCap);
        expect(linksPerPage * cappedOnPage).toBeGreaterThanOrEqual(recordCap);
        const totalPages = cappedOnPage + 2;
        loadPdfPageAnnotations.mockImplementation(async (
            _doc: unknown,
            pageNumber: number,
        ) => createLinkPageBundle(pageNumber, linksPerPage));

        await withAnnotationSyncScope(async () => {
            const warn = await spyOnAnnotationWarnings();
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('record-capped-document'),
                numPages: ref(totalPages),
            });

            await sync.syncAnnotationComments();

            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(cappedOnPage);
            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                omissions: ['record-cap'],
                scannedPageCount: cappedOnPage,
                totalPageCount: totalPages,
                failedPageCount: 0,
            }));
            expect(warn).toHaveBeenCalledWith(
                'annotations',
                'Background annotation inventory is incomplete',
                expect.objectContaining({ omissions: ['record-cap'] }),
            );
        });
    });

    it('stops at exactly the record cap rather than reading one page past it', async () => {
        // The very first page fills the budget to the record exactly. `>=` has
        // to stop here: pages remain, so scanning one more would push the
        // inventory past the cap it exists to enforce, and reporting the scan
        // complete would hide the pages it never reached.
        const { recordCap } = await readInventoryCaps();
        loadPdfPageAnnotations.mockImplementation(async (
            _doc: unknown,
            pageNumber: number,
        ) => createLinkPageBundle(pageNumber, recordCap));

        await withAnnotationSyncScope(async () => {
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('exact-record-cap-document'),
                numPages: ref(2),
            });

            await sync.syncAnnotationComments();

            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(1);
            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                omissions: ['record-cap'],
                scannedPageCount: 1,
                totalPageCount: 2,
            }));
        });
    });

    it('flags and warns a page that cannot be parsed instead of counting it as read', async () => {
        loadPdfPageAnnotations.mockImplementation(async (
            _doc: unknown,
            pageNumber: number,
        ) => (pageNumber === 2 ? null : createEmptyPageBundle()));

        await withAnnotationSyncScope(async () => {
            const warn = await spyOnAnnotationWarnings();
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('failing-page-document'),
                numPages: ref(3),
            });

            await sync.syncAnnotationComments();

            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                omissions: ['page-parse-failure'],
                scannedPageCount: 2,
                totalPageCount: 3,
                failedPageCount: 1,
            }));
            expect(warn).toHaveBeenCalledWith(
                'annotations',
                'Background annotation inventory is incomplete',
                expect.objectContaining({ failedPageCount: 1 }),
            );
        });
    });

    it('keeps a cap-truncated snapshot incomplete across the revision-keyed cache', async () => {
        const { recordCap } = await readInventoryCaps();
        const totalPages = 5;
        const linksPerPage = Math.ceil(recordCap / 3);
        loadPdfPageAnnotations.mockImplementation(async (
            _doc: unknown,
            pageNumber: number,
        ) => createLinkPageBundle(pageNumber, linksPerPage));

        await withAnnotationSyncScope(async () => {
            const first = await createSyncHarness({
                documentIdentity: ref('cached-capped-document'),
                documentRevisionToken: ref('revision-1'),
                numPages: ref(totalPages),
                pdfDocument: {},
            });
            await first.sync.syncAnnotationComments();
            const scanCalls = loadPdfPageAnnotations.mock.calls.length;

            const second = await createSyncHarness({
                documentIdentity: ref('cached-capped-document'),
                documentRevisionToken: ref('revision-1'),
                numPages: ref(totalPages),
                pdfDocument: {},
            });
            await second.sync.syncAnnotationComments();

            // A cache hit must not launder a truncated scan into a
            // complete-looking one, and a deterministic cap is not rescanned.
            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(scanCalls);
            expect(second.setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                omissions: ['record-cap'],
            }));
        });
    });

    it('rescans once after a page read failure and reports recovery', async () => {
        loadPdfPageAnnotations.mockImplementation(async (
            _doc: unknown,
            pageNumber: number,
        ) => (pageNumber === 2 ? null : createEmptyPageBundle()));

        await withAnnotationSyncScope(async () => {
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('recovering-document'),
                documentRevisionToken: ref('revision-1'),
                numPages: ref(3),
            });

            await sync.syncAnnotationComments();
            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(3);
            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                failedPageCount: 1,
            }));

            loadPdfPageAnnotations.mockImplementation(async () => createEmptyPageBundle());
            await sync.syncAnnotationComments();

            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(6);
            expect(setInventoryCompleteness).toHaveBeenLastCalledWith({
                complete: true,
                omissions: [],
                scannedPageCount: 3,
                totalPageCount: 3,
                failedPageCount: 0,
            });
        });
    });

    it('retries a failed page at most once per revision', async () => {
        loadPdfPageAnnotations.mockImplementation(async (
            _doc: unknown,
            pageNumber: number,
        ) => (pageNumber === 2 ? null : createEmptyPageBundle()));

        await withAnnotationSyncScope(async () => {
            const revision = ref('revision-1');
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('persistently-failing-document'),
                documentRevisionToken: revision,
                numPages: ref(3),
            });

            await sync.syncAnnotationComments();
            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(3);

            await sync.syncAnnotationComments();
            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(6);

            // The retry budget for this revision is spent; further syncs reuse
            // the cached snapshot instead of rescanning every time.
            await sync.syncAnnotationComments();
            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(6);

            revision.value = 'revision-2';
            await nextTick();
            await sync.syncAnnotationComments();
            expect(loadPdfPageAnnotations).toHaveBeenCalledTimes(9);
            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(expect.objectContaining({
                complete: false,
                failedPageCount: 1,
            }));
        });
    });

    it('clears the reported inventory when the document has no pages', async () => {
        loadPdfPageAnnotations.mockResolvedValue(createEmptyPageBundle());

        await withAnnotationSyncScope(async () => {
            const {
                sync,
                setInventoryCompleteness,
            } = await createSyncHarness({
                documentIdentity: ref('empty-document'),
                numPages: ref(0),
            });

            await sync.syncAnnotationComments();

            expect(setInventoryCompleteness).toHaveBeenLastCalledWith(null);
        });
    });
});
