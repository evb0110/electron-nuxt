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
import { toOpaqueHighlightDisplayColor } from '@app/composables/pdf/textMarkupColor';
import { applyAnnotationCommentTextMarkupColor } from '@app/composables/pdf/annotations/annotationDomRemoval';
import { getStoredAnnotationEditor } from '@app/services/pdfjs/annotationEditorMutation';
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

    function updateCachedAnnotationCommentColor(comment: IAnnotationCommentSummary, color: string) {
        annotationCommentModel.updateCachedColor(comment, color);
    }

    function applyEmbeddedMarkupDomColor(
        comment: IAnnotationCommentSummary,
        color: string,
        opts?: { forceVisible?: boolean },
    ) {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        const displayColor = annotationCommentModel.toTextMarkupSubtype(comment) === 'Highlight'
            ? toOpaqueHighlightDisplayColor(
                color,
                annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
            )
            : color;
        return applyAnnotationCommentTextMarkupColor(container, comment, displayColor, opts);
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
            const domUpdated = applyEmbeddedMarkupDomColor(comment, color, { forceVisible: subtype === 'Highlight' });
            BrowserLogger.debug('annotations', 'Updated context-menu text markup color', () => ({
                annotationId: comment.annotationId ?? null,
                stableKey: comment.stableKey,
                subtype,
                previousColor: comment.color ?? null,
                nextColor: color,
                editorFound: false,
                editorConnected: false,
                editorUpdated: false,
                domUpdated,
            }));
            updateCachedAnnotationCommentColor(comment, color);
            emitForcedAnnotationMutation();
            return true;
        }
        const editorUpdated = annotations.editor.markupSubtype.updateTextMarkupAnnotationColor(
            editor,
            comment.pageIndex,
            subtype,
            color,
        );
        const editorConnected = editor.div?.isConnected === true;
        // Connected editors already redraw through PDF.js and our subtype draw
        // layer; the DOM fallback is only for materialized annotations.
        const domUpdated = editorConnected
            ? false
            : applyEmbeddedMarkupDomColor(
                comment,
                color,
                { forceVisible: subtype === 'Highlight' },
            );
        const didUpdate = editorUpdated || domUpdated;
        BrowserLogger.debug('annotations', 'Updated context-menu text markup color', () => ({
            annotationId: comment.annotationId ?? null,
            stableKey: comment.stableKey,
            subtype,
            previousColor: comment.color ?? null,
            nextColor: color,
            editorFound: true,
            editorConnected,
            editorUpdated,
            domUpdated,
        }));
        if (didUpdate) {
            updateCachedAnnotationCommentColor(comment, color);
            emitForcedAnnotationMutation({ scheduleCommentSync: true });
        }
        return didUpdate;
    }

    return {
        updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor,
    };
}
