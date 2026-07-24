import {
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
    TMarkupSubtype,
} from '@app/types/annotations';
import { useAnnotationIdentity } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationIdentity';
import type { IPdfPageAnnotationBundle } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import { resolvePerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';

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
vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument', () => ({leasePdfDocumentPage}));
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
    const subtypeOverrides = new Map<string, TMarkupSubtype>();
    return {
        colorOverrides,
        subtypeOverrides,
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
            syncMarkupSubtypePresentationForEditors: vi.fn(),
            getMarkupSubtypeOverrides: vi.fn(() => subtypeOverrides),
            forgetMarkupSubtypeOverride: vi.fn((annotationId: string | null | undefined) => {
                if (!annotationId) {
                    return;
                }
                colorOverrides.delete(annotationId);
                subtypeOverrides.delete(annotationId);
            }),
            clearOverrides: vi.fn(() => {
                colorOverrides.clear();
                subtypeOverrides.clear();
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
} = {}) {
    const annotationCommentsCache = options.annotationCommentsCache ?? ref<IAnnotationCommentSummary[]>([]);
    const identity = useAnnotationIdentity(annotationCommentsCache);
    const markupSubtypeStore = createMarkupSubtypeStore();
    const setAnnotations = options.setAnnotations ?? vi.fn((comments: IAnnotationCommentSummary[]) => {
        annotationCommentsCache.value = comments;
        return comments;
    });
    const { useAnnotationSync } = await import('@app/modules/pdf-viewer/runtime/annotations/useAnnotationSync');
    const sync = useAnnotationSync({
        pdfDocument: shallowRef(options.pdfDocument ?? {}),
        documentIdentity: options.documentIdentity ?? ref('document'),
        documentRevisionToken: options.documentRevisionToken,
        numPages: ref(1),
        currentPage: ref(1),
        annotationUiManager: options.annotationUiManager ?? shallowRef(null),
        authorName: ref(null),
        getIdentity: () => identity,
        getMarkupSubtype: () => markupSubtypeStore.markupSubtype,
        getStore: () => ({
            setAnnotations,
            setLinkAnnotations: vi.fn(),
            setActiveKey: vi.fn(),
        }),
        syncInlineCommentIndicators: vi.fn(),
        getAnnotationNameReadLimits: () => options.limits ?? resolvePdfAnnotationNameReadLimits('medium'),
        getPdfSourceByteSize: options.getPdfSourceByteSize ?? (() => null),
        isPdfSourceBlob: options.isPdfSourceBlob ?? (() => false),
    } as never);
    return {
        annotationCommentsCache,
        ...markupSubtypeStore,
        setAnnotations,
        sync,
    };
}

describe('useAnnotationSync', () => {
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
                markupSubtype,
                subtypeOverrides,
                sync,
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
            expect(subtypeOverrides.get('12R0')).toBe('Underline');
            expect(markupSubtype.syncMarkupSubtypePresentationForEditors).toHaveBeenCalledTimes(3);
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
