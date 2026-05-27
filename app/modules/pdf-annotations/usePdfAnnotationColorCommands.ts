import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-annotations/usePdfAnnotationCommentModel';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { applyAnnotationCommentTextMarkupColor } from '@app/composables/pdf/annotations/annotationDomRemoval';
import { getStoredAnnotationEditor } from '@app/services/pdfjs/annotationEditorMutation';
import { toOpaqueHighlightDisplayColor } from '@app/composables/pdf/textMarkupColor';
import { BrowserLogger } from '@app/utils/browserLogger';

type TAnnotationOrchestrator = ReturnType<typeof useAnnotationOrchestrator>;
type TAnnotationCommentModel = ReturnType<typeof usePdfAnnotationCommentModel>;

interface IUsePdfAnnotationColorCommandsOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotations: TAnnotationOrchestrator;
    annotationCommentModel: TAnnotationCommentModel;
    emitForcedAnnotationMutation: (options?: { scheduleCommentSync?: boolean }) => void;
}

export function usePdfAnnotationColorCommands(options: IUsePdfAnnotationColorCommandsOptions) {
    const {
        viewerContainer,
        pdfDocument,
        annotationSettings,
        annotations,
        annotationCommentModel,
        emitForcedAnnotationMutation,
    } = options;

    function updateCachedAnnotationCommentColor(
        comment: IAnnotationCommentSummary,
        color: string,
        options: { colorEdited?: boolean } = {},
    ) {
        annotationCommentModel.updateCachedColor(comment, color, options);
    }

    function findTextMarkupEditorForComment(comment: IAnnotationCommentSummary) {
        return annotations.crud.findEditorForComment(comment)
            ?? (comment.annotationId
                ? annotations.crud.findEditorByAnnotationElementId(comment.pageIndex, comment.annotationId)
                : null)
            ?? (comment.annotationId
                ? getStoredAnnotationEditor(pdfDocument.value, comment.annotationId)
                : null);
    }

    function getRenderedMarkupDisplayColor(comment: IAnnotationCommentSummary, color: string) {
        const subtype = annotationCommentModel.toTextMarkupSubtype(comment);
        if (subtype !== 'Highlight') {
            return color;
        }
        return toOpaqueHighlightDisplayColor(
            color,
            annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
        );
    }

    function applyRenderedMarkupColor(
        comment: IAnnotationCommentSummary,
        color: string,
        opts: {
            forceVisible?: boolean;
            sourceColor?: string | null;
        } = {},
    ) {
        if (!viewerContainer.value) {
            return false;
        }
        return applyAnnotationCommentTextMarkupColor(
            viewerContainer.value,
            comment,
            getRenderedMarkupDisplayColor(comment, color),
            opts,
        );
    }

    function updateSelectedTextMarkupAnnotationColor(color: string) {
        const didUpdate = annotations.editor.markupSubtype.updateSelectedTextMarkupAnnotationColor(color);
        if (didUpdate) {
            emitForcedAnnotationMutation({ scheduleCommentSync: true });
        }
        return didUpdate;
    }

    function updateTextMarkupAnnotationColor(comment: IAnnotationCommentSummary, color: string) {
        const subtype = annotationCommentModel.toTextMarkupSubtype(comment);
        const editor = findTextMarkupEditorForComment(comment);
        if (!subtype) {
            return false;
        }
        annotations.editor.markupSubtype.rememberMarkupSubtypeColorOverride(comment.annotationId, color);
        if (!editor) {
            const renderedUpdated = applyRenderedMarkupColor(comment, color, { sourceColor: comment.color ?? null });
            BrowserLogger.debug('annotations', 'Updated context-menu text markup color', () => ({
                annotationId: comment.annotationId ?? null,
                stableKey: comment.stableKey,
                subtype,
                previousColor: comment.color ?? null,
                nextColor: color,
                editorFound: false,
                editorConnected: false,
                editorUpdated: false,
                renderedUpdated,
                preview: renderedUpdated ? 'rendered-page' : 'rendered-page-missing',
            }));
            updateCachedAnnotationCommentColor(comment, color, { colorEdited: comment.colorEdited !== false });
            emitForcedAnnotationMutation();
            return renderedUpdated;
        }
        const editorUpdated = annotations.editor.markupSubtype.updateTextMarkupAnnotationColor(
            editor,
            comment.pageIndex,
            subtype,
            color,
        );
        const editorConnected = editor.div?.isConnected === true;
        const renderedUpdated = editorConnected
            ? false
            : applyRenderedMarkupColor(comment, color, { sourceColor: comment.color ?? null });
        const didUpdate = (editorUpdated && editorConnected) || renderedUpdated;
        BrowserLogger.debug('annotations', 'Updated context-menu text markup color', () => ({
            annotationId: comment.annotationId ?? null,
            stableKey: comment.stableKey,
            subtype,
            previousColor: comment.color ?? null,
            nextColor: color,
            editorFound: true,
            editorConnected,
            editorUpdated,
            renderedUpdated,
            preview: editorUpdated && editorConnected
                ? 'editor'
                : (renderedUpdated ? 'rendered-page' : 'rendered-page-missing'),
        }));
        updateCachedAnnotationCommentColor(comment, color, { colorEdited: comment.colorEdited !== false });
        emitForcedAnnotationMutation({ scheduleCommentSync: didUpdate });
        return didUpdate;
    }

    return {
        updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor,
    };
}
