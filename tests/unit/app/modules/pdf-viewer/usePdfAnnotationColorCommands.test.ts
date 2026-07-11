import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {shallowRef} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

const {getStoredAnnotationEditor} = vi.hoisted(() => ({getStoredAnnotationEditor: vi.fn(() => null)}));

vi.mock('@app/services/pdfjs/annotationEditorMutation', () => ({ getStoredAnnotationEditor }));

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'ann-1',
        stableKey: overrides.stableKey ?? 'ann:0:ann-1',
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
    });

    it('describes connected underline markup rendered-page fallback work', async () => {
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
            toTextMarkupSubtype: vi.fn(() => 'Underline'),
            updateCachedColor: vi.fn(),
        };
        const emitForcedAnnotationMutation = vi.fn();
        const commands = usePdfAnnotationColorCommands({
            pdfDocument: shallowRef(null),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation,
        });
        const comment = createComment();

        const result = commands.updateTextMarkupAnnotationColor(comment, '#22c55e');

        expect(annotations.editor.markupSubtype.updateTextMarkupAnnotationColor).toHaveBeenCalledWith(
            editor,
            0,
            'Underline',
            '#22c55e',
        );
        expect(result).toMatchObject({
            updated: true,
            shouldApplyTextMarkupColor: true,
            shouldRefreshPage: true,
            shouldScheduleCommentSync: true,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                color: '#22c55e',
                colorEdited: true,
            }),
        });
        expect(annotationCommentModel.updateCachedColor).toHaveBeenCalledWith(
            comment,
            '#22c55e',
            { colorEdited: true },
        );
        expect(emitForcedAnnotationMutation).toHaveBeenCalledWith({ scheduleCommentSync: true });
    });

    it('describes selected underline markup rendered-page fallback work', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
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
        const commands = usePdfAnnotationColorCommands({
            pdfDocument: shallowRef(null),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        const result = commands.updateSelectedTextMarkupAnnotationColor('#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldApplyTextMarkupColor: true,
            shouldRefreshPage: true,
            shouldScheduleCommentSync: true,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                annotationId: '12R0',
                color: '#22c55e',
                markerRect: selectedMarkup.markerRect,
                pageIndex: 0,
                pageNumber: 1,
                subtype: 'Underline',
            }),
        });
        expect(annotationCommentModel.updateCachedColor).toHaveBeenCalledWith(
            expect.objectContaining({
                annotationId: '12R0',
                stableKey: 'ann:0:12R0',
            }),
            '#22c55e',
            {},
        );
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
            pdfDocument: shallowRef({ annotationStorage: { resetModifiedIds } } as never),
            annotations: annotations as never,
            annotationCommentModel: {
                toTextMarkupSubtype: vi.fn(() => 'Underline'),
                updateCachedColor: vi.fn(),
            } as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        expect(commands.updateSelectedTextMarkupAnnotationColor('#22c55e')).toMatchObject({ updated: true });

        expect(resetModifiedIds).toHaveBeenCalledTimes(1);
    });

    it('describes unconnected highlight rendered-page fallback work', async () => {
        const { usePdfAnnotationColorCommands } = await import('@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands');
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
            pdfDocument: shallowRef(null),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation: vi.fn(),
        });
        const comment = createComment({ subtype: 'Highlight' });

        const result = commands.updateTextMarkupAnnotationColor(comment, '#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldApplyTextMarkupColor: true,
            shouldRefreshPage: true,
            shouldScheduleCommentSync: false,
            sourceColor: '#ef4444',
            comment: expect.objectContaining({
                color: '#22c55e',
                subtype: 'Highlight',
            }),
        });
    });

    it('does not request the rendered-page color fallback for connected highlights', async () => {
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
            pdfDocument: shallowRef(null),
            annotations: annotations as never,
            annotationCommentModel: annotationCommentModel as never,
            emitForcedAnnotationMutation: vi.fn(),
        });

        const result = commands.updateTextMarkupAnnotationColor(createComment({ subtype: 'Highlight' }), '#22c55e');

        expect(result).toMatchObject({
            updated: true,
            shouldApplyTextMarkupColor: false,
            shouldRefreshPage: true,
            shouldScheduleCommentSync: true,
            comment: expect.objectContaining({
                color: '#22c55e',
                subtype: 'Highlight',
            }),
        });
    });
});
