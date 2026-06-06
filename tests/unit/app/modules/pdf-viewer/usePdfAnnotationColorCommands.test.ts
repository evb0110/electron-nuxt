import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';

const {
    applyAnnotationCommentTextMarkupColor,
    applyAnnotationCommentTextMarkupVisualOverlay,
    getStoredAnnotationEditor,
} = vi.hoisted(() => ({
    applyAnnotationCommentTextMarkupColor: vi.fn(() => true),
    applyAnnotationCommentTextMarkupVisualOverlay: vi.fn(() => true),
    getStoredAnnotationEditor: vi.fn(() => null),
}));

vi.mock('@app/utils/pdf-viewer/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor', () => ({applyAnnotationCommentTextMarkupColor}));
vi.mock('@app/utils/pdf-viewer/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupVisualOverlay', () => ({applyAnnotationCommentTextMarkupVisualOverlay}));

vi.mock('@app/services/pdfjs/annotationEditorMutation', () => ({ getStoredAnnotationEditor }));

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'ann-1',
        stableKey: overrides.stableKey ?? 'ann-1',
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'Marked text',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'Underline',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? '#ef4444',
        colorEdited: overrides.colorEdited,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? '12R0',
        source: overrides.source ?? 'pdf',
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        },
    };
}

describe('usePdfAnnotationColorCommands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        applyAnnotationCommentTextMarkupColor.mockReturnValue(true);
        applyAnnotationCommentTextMarkupVisualOverlay.mockReturnValue(true);
    });

    it('repaints connected underline markup through the rendered-page fallback', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
        const viewerContainer = {} as HTMLElement;
        const editor = { div: { isConnected: true } };
        const annotations = {
            crud: {
                findEditorForComment: vi.fn(() => editor),
                findEditorByAnnotationElementId: vi.fn(() => null),
            },
            editor: { markupSubtype: {
                rememberMarkupSubtypeColorOverride: vi.fn(),
                updateSelectedTextMarkupAnnotationColor: vi.fn(),
                updateTextMarkupAnnotationColor: vi.fn(() => true),
            } },
        };
        const annotationCommentModel = {
            toTextMarkupSubtype: vi.fn(() => 'Underline'),
            updateCachedColor: vi.fn(),
        };
        const emitForcedAnnotationMutation = vi.fn();
        const refreshEditedTextMarkupPage = vi.fn();
        const commands = usePdfAnnotationColorCommands({
            viewerContainer: ref(viewerContainer),
            pdfDocument: shallowRef(null),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation,
            refreshEditedTextMarkupPage,
        });
        const comment = createComment();

        expect(commands.updateTextMarkupAnnotationColor(comment, '#22c55e')).toBe(true);

        expect(annotations.editor.markupSubtype.updateTextMarkupAnnotationColor).toHaveBeenCalledWith(
            editor,
            0,
            'Underline',
            '#22c55e',
        );
        expect(applyAnnotationCommentTextMarkupColor).toHaveBeenCalledWith(
            viewerContainer,
            comment,
            '#22c55e',
            {
                sourceColor: '#ef4444',
                suppressNativeTextMarkupDecoration: true,
            },
        );
        expect(annotationCommentModel.updateCachedColor).toHaveBeenCalledWith(
            comment,
            '#22c55e',
            { colorEdited: true },
        );
        expect(refreshEditedTextMarkupPage).toHaveBeenCalledWith(1);
        expect(emitForcedAnnotationMutation).toHaveBeenCalledWith({ scheduleCommentSync: true });
    });

    it('repaints selected underline markup through the rendered-page fallback', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
        const viewerContainer = {} as HTMLElement;
        const selectedMarkup = {
            id: '12R0',
            pageIndex: 0,
            subtype: 'Underline',
            color: '#ef4444',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            },
        };
        const annotations = {
            crud: {
                findEditorForComment: vi.fn(() => null),
                findEditorByAnnotationElementId: vi.fn(() => null),
            },
            editor: { markupSubtype: {
                getSelectedTextMarkupAnnotationProperties: vi.fn(() => selectedMarkup),
                rememberMarkupSubtypeColorOverride: vi.fn(),
                updateSelectedTextMarkupAnnotationColor: vi.fn(() => true),
                updateTextMarkupAnnotationColor: vi.fn(() => true),
            } },
        };
        const annotationCommentModel = {
            toTextMarkupSubtype: vi.fn(() => 'Underline'),
            updateCachedColor: vi.fn(),
        };
        const refreshEditedTextMarkupPage = vi.fn();
        const commands = usePdfAnnotationColorCommands({
            viewerContainer: ref(viewerContainer),
            pdfDocument: shallowRef(null),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation: vi.fn(),
            refreshEditedTextMarkupPage,
        });

        expect(commands.updateSelectedTextMarkupAnnotationColor('#22c55e')).toBe(true);

        expect(applyAnnotationCommentTextMarkupColor).toHaveBeenCalledWith(
            viewerContainer,
            expect.objectContaining({
                annotationId: '12R0',
                color: '#ef4444',
                markerRect: selectedMarkup.markerRect,
                pageIndex: 0,
                pageNumber: 1,
                subtype: 'Underline',
            }),
            '#22c55e',
            {
                sourceColor: '#ef4444',
                suppressNativeTextMarkupDecoration: true,
            },
        );
        expect(annotationCommentModel.updateCachedColor).toHaveBeenCalledWith(
            expect.objectContaining({
                annotationId: '12R0',
                stableKey: '12R0',
            }),
            '#22c55e',
            {},
        );
        expect(refreshEditedTextMarkupPage).toHaveBeenCalledWith(1);
    });

    it('resets cached PDF.js modified ids when text-markup color changes', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
        const resetModifiedIds = vi.fn();
        const selectedMarkup = {
            id: '12R0',
            pageIndex: 0,
            subtype: 'Underline',
            color: '#ef4444',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.04,
            },
        };
        const annotations = {
            crud: {
                findEditorForComment: vi.fn(() => null),
                findEditorByAnnotationElementId: vi.fn(() => null),
            },
            editor: { markupSubtype: {
                getSelectedTextMarkupAnnotationProperties: vi.fn(() => selectedMarkup),
                rememberMarkupSubtypeColorOverride: vi.fn(),
                updateSelectedTextMarkupAnnotationColor: vi.fn(() => true),
                updateTextMarkupAnnotationColor: vi.fn(() => true),
            } },
        };
        const commands = usePdfAnnotationColorCommands({
            viewerContainer: ref({} as HTMLElement),
            pdfDocument: shallowRef({ annotationStorage: { resetModifiedIds } } as never),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            annotations: annotations as never,
            annotationCommentModel: {
                toTextMarkupSubtype: vi.fn(() => 'Underline'),
                updateCachedColor: vi.fn(),
            } as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        expect(commands.updateSelectedTextMarkupAnnotationColor('#22c55e')).toBe(true);

        expect(resetModifiedIds).toHaveBeenCalledTimes(1);
    });

    it('keeps edited highlight overlay color raw while DOM fallback uses blended display color', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
        const viewerContainer = {} as HTMLElement;
        const annotations = {
            crud: {
                findEditorForComment: vi.fn(() => null),
                findEditorByAnnotationElementId: vi.fn(() => null),
            },
            editor: { markupSubtype: {
                rememberMarkupSubtypeColorOverride: vi.fn(),
                updateSelectedTextMarkupAnnotationColor: vi.fn(),
                updateTextMarkupAnnotationColor: vi.fn(() => true),
            } },
        };
        const annotationCommentModel = {
            toTextMarkupSubtype: vi.fn(() => 'Highlight'),
            updateCachedColor: vi.fn(),
        };
        const commands = usePdfAnnotationColorCommands({
            viewerContainer: ref(viewerContainer),
            pdfDocument: shallowRef(null),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation: vi.fn(),
        });
        const comment = createComment({ subtype: 'Highlight' });

        expect(commands.updateTextMarkupAnnotationColor(comment, '#22c55e')).toBe(true);

        expect(applyAnnotationCommentTextMarkupColor).toHaveBeenCalledWith(
            viewerContainer,
            comment,
            '#b2ebc7',
            {
                sourceColor: '#ef4444',
                suppressNativeTextMarkupDecoration: true,
            },
        );
        expect(applyAnnotationCommentTextMarkupVisualOverlay).toHaveBeenCalledWith(
            viewerContainer,
            comment,
            '#22c55e',
            { highlightOpacity: DEFAULT_ANNOTATION_SETTINGS.highlightOpacity },
        );
    });

    it('does not run the rendered-page fallback for connected highlights', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
        const editor = { div: { isConnected: true } };
        const annotations = {
            crud: {
                findEditorForComment: vi.fn(() => editor),
                findEditorByAnnotationElementId: vi.fn(() => null),
            },
            editor: { markupSubtype: {
                rememberMarkupSubtypeColorOverride: vi.fn(),
                updateSelectedTextMarkupAnnotationColor: vi.fn(),
                updateTextMarkupAnnotationColor: vi.fn(() => true),
            } },
        };
        const annotationCommentModel = {
            toTextMarkupSubtype: vi.fn(() => 'Highlight'),
            updateCachedColor: vi.fn(),
        };
        const commands = usePdfAnnotationColorCommands({
            viewerContainer: ref({} as HTMLElement),
            pdfDocument: shallowRef(null),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        expect(commands.updateTextMarkupAnnotationColor(createComment({ subtype: 'Highlight' }), '#22c55e')).toBe(true);

        expect(applyAnnotationCommentTextMarkupColor).not.toHaveBeenCalled();
    });
});
