import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    ITextMarkupAnnotationProperties,
} from '@app/types/annotations';
import type { useAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationOrchestrator';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { applyAnnotationCommentTextMarkupColor } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor';
import { applyAnnotationCommentTextMarkupVisualOverlay } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupVisualOverlay';
import { getStoredAnnotationEditor } from '@app/services/pdfjs/annotationEditorMutation';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';
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
    refreshEditedTextMarkupPage?: ((pageNumber: number) => void) | undefined;
}

export function usePdfAnnotationColorCommands(options: IUsePdfAnnotationColorCommandsOptions) {
    const {
        viewerContainer,
        pdfDocument,
        annotationSettings,
        annotations,
        annotationCommentModel,
        emitForcedAnnotationMutation,
        refreshEditedTextMarkupPage,
    } = options;

    function updateCachedAnnotationCommentColor(
        comment: IAnnotationCommentSummary,
        color: string,
        options: { colorEdited?: boolean } = {},
    ) {
        annotationCommentModel.updateCachedColor(comment, color, options);
    }

    function resetAnnotationStorageModifiedIds() {
        const annotationStorage = pdfDocument.value?.annotationStorage as { resetModifiedIds?: () => void } | undefined;
        annotationStorage?.resetModifiedIds?.();
    }

    function refreshRenderedMarkupPage(comment: IAnnotationCommentSummary) {
        const pageNumber = Math.floor(comment.pageNumber);
        if (Number.isFinite(pageNumber) && pageNumber > 0) {
            refreshEditedTextMarkupPage?.(pageNumber);
        }
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

    function getRenderedMarkupOverlayColor(comment: IAnnotationCommentSummary, color: string) {
        const subtype = annotationCommentModel.toTextMarkupSubtype(comment);
        return subtype === 'Highlight'
            ? color
            : getRenderedMarkupDisplayColor(comment, color);
    }

    function getRenderedMarkupHighlightOpacity(comment: IAnnotationCommentSummary) {
        const subtype = annotationCommentModel.toTextMarkupSubtype(comment);
        return subtype === 'Highlight'
            ? annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity
            : null;
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
        const displayColor = getRenderedMarkupDisplayColor(comment, color);
        const didApplyRenderedColor = applyAnnotationCommentTextMarkupColor(
            viewerContainer.value,
            comment,
            displayColor,
            {
                ...opts,
                suppressNativeTextMarkupDecoration: true,
            },
        );
        const didApplyStableOverlay = applyAnnotationCommentTextMarkupVisualOverlay(
            viewerContainer.value,
            comment,
            getRenderedMarkupOverlayColor(comment, color),
            { highlightOpacity: getRenderedMarkupHighlightOpacity(comment) },
        );
        return didApplyRenderedColor || didApplyStableOverlay;
    }

    function toSelectedTextMarkupComment(markup: ITextMarkupAnnotationProperties): IAnnotationCommentSummary {
        return {
            id: markup.id,
            stableKey: markup.id,
            pageIndex: markup.pageIndex,
            pageNumber: markup.pageIndex + 1,
            text: '',
            author: null,
            modifiedAt: null,
            color: markup.color,
            uid: null,
            annotationId: markup.id,
            source: 'editor',
            subtype: markup.subtype,
            markerRect: markup.markerRect,
        };
    }

    function updateSelectedTextMarkupAnnotationColor(color: string) {
        const selectedMarkup = annotations.editor.markupSubtype.getSelectedTextMarkupAnnotationProperties();
        const didUpdate = annotations.editor.markupSubtype.updateSelectedTextMarkupAnnotationColor(color);
        if (didUpdate) {
            const selectedComment = selectedMarkup ? toSelectedTextMarkupComment(selectedMarkup) : null;
            if (selectedComment) {
                updateCachedAnnotationCommentColor(selectedComment, color);
            }
            if (selectedMarkup?.subtype && selectedMarkup.subtype !== 'Highlight') {
                applyRenderedMarkupColor(
                    selectedComment ?? toSelectedTextMarkupComment(selectedMarkup),
                    color,
                    { sourceColor: selectedMarkup.color },
                );
            }
            if (selectedComment) {
                refreshRenderedMarkupPage(selectedComment);
            }
            resetAnnotationStorageModifiedIds();
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
            refreshRenderedMarkupPage(comment);
            resetAnnotationStorageModifiedIds();
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
        const renderedUpdated = (!editorConnected || subtype !== 'Highlight')
            ? applyRenderedMarkupColor(comment, color, { sourceColor: comment.color ?? null })
            : false;
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
        refreshRenderedMarkupPage(comment);
        resetAnnotationStorageModifiedIds();
        emitForcedAnnotationMutation({ scheduleCommentSync: didUpdate });
        return didUpdate;
    }

    return {
        updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor,
    };
}
