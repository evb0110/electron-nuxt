import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import { useAnnotationIdentity } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationIdentity';
import type { IPdfPageAnnotationBundle } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

const { loadPdfPageAnnotations } = vi.hoisted(() => ({loadPdfPageAnnotations: vi.fn<(_doc: unknown, _pageNumber: number) => Promise<IPdfPageAnnotationBundle | null>>()}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({PDFDateString: {toDateObject: vi.fn(() => null)}}));

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

describe('useAnnotationSync', () => {
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
            const identity = useAnnotationIdentity(annotationCommentsCache);
            const {
                colorOverrides,
                subtypeOverrides,
                markupSubtype,
            } = createMarkupSubtypeStore();
            const appliedColor = '#22c55e';
            const setAnnotations = vi.fn((comments: IAnnotationCommentSummary[]) => {
                const appliedComments = comments.map(comment => ({
                    ...comment,
                    color: comment.annotationId === '12R0' ? appliedColor : comment.color,
                    colorEdited: comment.annotationId === '12R0' ? true : comment.colorEdited,
                }));
                annotationCommentsCache.value = appliedComments;
                return appliedComments;
            });
            const { useAnnotationSync } = await import('@app/modules/pdf-viewer/runtime/annotations/useAnnotationSync');
            const sync = useAnnotationSync({
                pdfDocument: shallowRef({}),
                numPages: ref(1),
                currentPage: ref(1),
                annotationUiManager: shallowRef(null),
                authorName: ref(null),
                getIdentity: () => identity,
                getMarkupSubtype: () => markupSubtype,
                getStore: () => ({
                    setAnnotations,
                    setLinkAnnotations: vi.fn(),
                    setActiveKey: vi.fn(),
                }),
                syncInlineCommentIndicators: vi.fn(),
            } as never);

            await sync.syncAnnotationComments();

            expect(setAnnotations).toHaveBeenCalledWith([expect.objectContaining({
                annotationId: '12R0',
                color: '#ef4444',
                subtype: 'Underline',
            })]);
            expect(colorOverrides.get('12R0')).toBe(appliedColor);
            expect(subtypeOverrides.get('12R0')).toBe('Underline');
            expect(markupSubtype.syncMarkupSubtypePresentationForEditors).toHaveBeenCalledTimes(1);
        });
    });
});
