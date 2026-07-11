import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';
import type { usePdfAnnotationCommentModel } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel';
import type { usePdfShapeTool } from '@app/modules/pdf-viewer/tools/public';
import type { IPageRange } from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';

type TPdfAnnotationCommentModel = ReturnType<typeof usePdfAnnotationCommentModel>;
type TPdfShapeTool = ReturnType<typeof usePdfShapeTool>;

interface IUsePdfAnnotationCommentActionsOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    activeCommentStableKey: Ref<string | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    annotationCommentModel: TPdfAnnotationCommentModel;
    shapeTool: TPdfShapeTool;
    shapeComposable: {focusShape: (shapeId: string | null) => void;};
    selectedShapeCommands: {deleteShapeById: (shapeId: string) => boolean;};
    commentCrud: {
        focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
        deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    };
    scrollToPage: (pageNumber: number, options?: { markerRect?: IAnnotationCommentSummary['markerRect'] }) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    emitForcedAnnotationMutation: () => void;
}

export const usePdfAnnotationCommentActions = (options: IUsePdfAnnotationCommentActionsOptions) => {
    const {
        viewerContainer,
        numPages,
        activeCommentStableKey,
        annotationCommentsCache,
        annotationCommentModel,
        shapeTool,
        shapeComposable,
        selectedShapeCommands,
        commentCrud,
        scrollToPage,
        updateVisibleRange,
        renderVisiblePages,
        emitForcedAnnotationMutation,
    } = options;

    async function focusShapeAnnotationComment(comment: IAnnotationCommentSummary) {
        const shape = shapeTool.findShapeForAnnotationComment(comment);
        if (!shape) {
            return;
        }

        activeCommentStableKey.value = annotationIdForSummary(comment);
        shapeComposable.focusShape(shape.id);

        const pageNumber = Math.min(
            Math.max(comment.pageNumber, 1),
            Math.max(1, numPages.value),
        );
        scrollToPage(pageNumber, { markerRect: comment.markerRect });

        await nextTick();
        updateVisibleRange(viewerContainer.value, numPages.value);
        try {
            await renderVisiblePages(
                {
                    start: pageNumber,
                    end: pageNumber,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                },
            );
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to render page ${pageNumber} while focusing shape annotation`, error);
        }
    }

    async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
        if (comment.source === 'shape') {
            await focusShapeAnnotationComment(comment);
            return;
        }

        shapeComposable.focusShape(null);
        await commentCrud.focusAnnotationComment(comment);
    }

    async function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
        if (comment.source === 'shape') {
            const shape = shapeTool.findShapeForAnnotationComment(comment);
            if (!shape) {
                return false;
            }
            if (!selectedShapeCommands.deleteShapeById(shape.id)) {
                return false;
            }
            annotationCommentModel.emitCommentsForSidebar(annotationCommentsCache.value);
            return true;
        }

        if (annotationCommentModel.isGracePreservedEditorOnlyComment(comment)) {
            annotationCommentModel.markLocallyDeleted(comment);
            emitForcedAnnotationMutation();
            return true;
        }

        const deleted = await commentCrud.deleteAnnotationComment(comment);
        if (deleted) {
            annotationCommentModel.markLocallyDeleted(comment);
        }
        return deleted;
    }

    return {
        focusAnnotationComment,
        deleteAnnotationComment,
    };
};
