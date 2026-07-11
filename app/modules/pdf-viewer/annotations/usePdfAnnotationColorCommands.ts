import type {ShallowRef} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type {
    IAnnotationCommentSummary,
    ITextMarkupAnnotationProperties,
} from '@app/types/annotations';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';
import type { TAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/annotationOrchestrator';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import { getStoredAnnotationEditor } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import { BrowserLogger } from '@app/utils/browserLogger';
import { resetLivePdfJsAnnotationStorageModifiedIds } from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';

type TAnnotationCommentModel = ReturnType<typeof usePdfAnnotationCommentModel>;

interface IUsePdfAnnotationColorCommandsOptions {
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotations: TAnnotationOrchestrator;
    annotationCommentModel: TAnnotationCommentModel;
    emitForcedAnnotationMutation: (options?: { scheduleCommentSync?: boolean }) => void;
}

export interface ITextMarkupColorMutationResult {
    updated: boolean;
    shouldScheduleCommentSync: boolean;
    shouldRefreshPage: boolean;
    shouldApplyTextMarkupColor: boolean;
    comment: IAnnotationCommentSummary | null;
    sourceColor: string | null;
}

export const usePdfAnnotationColorCommands = (options: IUsePdfAnnotationColorCommandsOptions) => {
    const {
        pdfDocument,
        annotations,
        annotationCommentModel,
        emitForcedAnnotationMutation,
    } = options;

    const noopColorMutationResult: ITextMarkupColorMutationResult = {
        updated: false,
        shouldScheduleCommentSync: false,
        shouldRefreshPage: false,
        shouldApplyTextMarkupColor: false,
        comment: null,
        sourceColor: null,
    };

    function updateCachedAnnotationCommentColor(
        comment: IAnnotationCommentSummary,
        color: string,
        options: { colorEdited?: boolean } = {},
    ) {
        annotationCommentModel.updateCachedColor(comment, color, options);
    }

    function resetAnnotationStorageModifiedIds() {
        resetLivePdfJsAnnotationStorageModifiedIds(pdfDocument.value);
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

    function createColorMutationResult(
        comment: IAnnotationCommentSummary,
        color: string,
        options: {
            updated: boolean;
            shouldScheduleCommentSync: boolean;
            shouldRefreshPage: boolean;
            shouldApplyTextMarkupColor: boolean;
            sourceColor: string | null;
            colorEdited?: boolean;
        },
    ): ITextMarkupColorMutationResult {
        return {
            updated: options.updated,
            shouldScheduleCommentSync: options.shouldScheduleCommentSync,
            shouldRefreshPage: options.shouldRefreshPage,
            shouldApplyTextMarkupColor: options.shouldApplyTextMarkupColor,
            comment: {
                ...comment,
                color,
                colorEdited: options.colorEdited ?? comment.colorEdited,
            },
            sourceColor: options.sourceColor,
        };
    }

    function toSelectedTextMarkupComment(markup: ITextMarkupAnnotationProperties): IAnnotationCommentSummary {
        return {
            id: markup.id,
            stableKey: computeSummaryStableKey({
                id: markup.id,
                pageIndex: markup.pageIndex,
                source: 'editor',
                annotationId: markup.id,
            }),
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
            if (selectedComment) {
                resetAnnotationStorageModifiedIds();
                emitForcedAnnotationMutation({ scheduleCommentSync: true });
                return createColorMutationResult(selectedComment, color, {
                    updated: true,
                    shouldScheduleCommentSync: true,
                    shouldRefreshPage: true,
                    shouldApplyTextMarkupColor: Boolean(selectedMarkup?.subtype && selectedMarkup.subtype !== 'Highlight'),
                    sourceColor: selectedMarkup?.color ?? null,
                });
            }
            resetAnnotationStorageModifiedIds();
            emitForcedAnnotationMutation({ scheduleCommentSync: true });
        }
        return didUpdate
            ? {
                ...noopColorMutationResult,
                updated: true,
                shouldScheduleCommentSync: true,
            }
            : noopColorMutationResult;
    }

    function updateTextMarkupAnnotationColor(comment: IAnnotationCommentSummary, color: string) {
        const subtype = annotationCommentModel.toTextMarkupSubtype(comment);
        const editor = findTextMarkupEditorForComment(comment);
        if (!subtype) {
            return noopColorMutationResult;
        }
        annotations.editor.markupSubtype.rememberMarkupSubtypeColorOverride(comment.annotationId, color);
        const sourceColor = comment.color ?? null;
        if (!editor) {
            BrowserLogger.debug('annotations', 'Updated context-menu text markup color', () => ({
                annotationId: comment.annotationId ?? null,
                stableKey: comment.stableKey,
                subtype,
                previousColor: comment.color ?? null,
                nextColor: color,
                editorFound: false,
                editorConnected: false,
                editorUpdated: false,
                renderedQueued: true,
                preview: 'rendered-page',
            }));
            updateCachedAnnotationCommentColor(comment, color, { colorEdited: comment.colorEdited !== false });
            resetAnnotationStorageModifiedIds();
            emitForcedAnnotationMutation();
            return createColorMutationResult(comment, color, {
                updated: true,
                shouldScheduleCommentSync: false,
                shouldRefreshPage: true,
                shouldApplyTextMarkupColor: true,
                sourceColor,
                colorEdited: comment.colorEdited !== false,
            });
        }
        const editorUpdated = annotations.editor.markupSubtype.updateTextMarkupAnnotationColor(
            editor,
            comment.pageIndex,
            subtype,
            color,
        );
        const editorConnected = editor.div?.isConnected === true;
        const shouldApplyTextMarkupColor = !editorConnected || subtype !== 'Highlight';
        const didUpdate = (editorUpdated && editorConnected) || shouldApplyTextMarkupColor;
        BrowserLogger.debug('annotations', 'Updated context-menu text markup color', () => ({
            annotationId: comment.annotationId ?? null,
            stableKey: comment.stableKey,
            subtype,
            previousColor: comment.color ?? null,
            nextColor: color,
            editorFound: true,
            editorConnected,
            editorUpdated,
            renderedQueued: shouldApplyTextMarkupColor,
            preview: editorUpdated && editorConnected
                ? 'editor'
                : (shouldApplyTextMarkupColor ? 'rendered-page' : 'rendered-page-missing'),
        }));
        updateCachedAnnotationCommentColor(comment, color, { colorEdited: comment.colorEdited !== false });
        resetAnnotationStorageModifiedIds();
        emitForcedAnnotationMutation({ scheduleCommentSync: didUpdate });
        return createColorMutationResult(comment, color, {
            updated: didUpdate,
            shouldScheduleCommentSync: didUpdate,
            shouldRefreshPage: true,
            shouldApplyTextMarkupColor,
            sourceColor,
            colorEdited: comment.colorEdited !== false,
        });
    }

    return {
        updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor,
    };
};
