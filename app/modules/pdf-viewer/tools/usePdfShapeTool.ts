import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { useAnnotationShapes } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';
import { usePdfSelectedShapeCommands } from '@app/modules/pdf-viewer/tools/usePdfSelectedShapeCommands';
import { usePdfShapeContext } from '@app/modules/pdf-viewer/tools/usePdfShapeContext';
import { isSelectionInteractionTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionInteractionTool';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { cloneShape } from '@app/modules/pdf-viewer/engine/shapes/cloneShape';

interface IUsePdfShapeToolOptions {
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    isAnySaving: Ref<boolean>;
    annotationApplication: ShallowRef<AnnotationApplication>;
    markModified: () => void;
    emitShapeContextMenu: (payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) => void;
    getDeletedShapeHandler: () => ((shape: IShapeAnnotation) => void) | null;
    getShapeCommentsChangedHandler: () => (() => void) | null;
}

export const usePdfShapeTool = (options: IUsePdfShapeToolOptions) => {
    const shapeComposable = useAnnotationShapes({
        annotationApplication: options.annotationApplication,
        notifyShapeCommentsChanged: () => options.getShapeCommentsChangedHandler()?.(),
    });

    function handleShapeCreated(shape: IShapeAnnotation) {
        options.annotationApplication.value.createShapeFromGeometry(shape);
        options.markModified();
        options.getShapeCommentsChangedHandler()?.();
    }

    function resolveShapeAnnotationId(shape: IShapeAnnotation) {
        const annotationId = options.annotationApplication.value.annotationIdForShape(shape);
        if (!annotationId) {
            throw new Error(`Missing canonical AnnotationId for shape ${shape.id}`);
        }
        return annotationId;
    }

    function applyShapeUpdateWithHistory(previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) {
        options.annotationApplication.value.replaceShapeGeometry(
            resolveShapeAnnotationId(previousShape),
            cloneShape(nextShape),
            cloneShape(previousShape),
        );
        options.markModified();
        options.getShapeCommentsChangedHandler()?.();
    }

    function previewShapeUpdate(shape: IShapeAnnotation) {
        options.annotationApplication.value.previewShapeGeometry(
            resolveShapeAnnotationId(shape),
            cloneShape(shape),
        );
    }

    function deleteShape(shape: IShapeAnnotation) {
        const application = options.annotationApplication.value;
        const annotationId = resolveShapeAnnotationId(shape);
        if (!application.store.get(annotationId)?.deleted) {
            application.store.delete(annotationId);
        }
        options.getDeletedShapeHandler()?.(shape);
    }

    const selectedShapeCommands = usePdfSelectedShapeCommands({
        selectedShapeId: shapeComposable.selectedShapeId,
        hasShapes: shapeComposable.hasShapes,
        isAnySaving: options.isAnySaving,
        getShapeById: shapeComposable.getShapeById,
        selectShape: shapeComposable.selectShape,
        executeShapeUpdate: applyShapeUpdateWithHistory,
        executeShapeDelete: deleteShape,
        notifyShapeCommentsChanged: () => options.getShapeCommentsChangedHandler()?.(),
        markModified: options.markModified,
    });

    usePdfShapeContext({
        shapeComposable,
        annotationTool: options.annotationTool,
        annotationSettings: options.annotationSettings,
        onShapeCreated: handleShapeCreated,
        onShapeUpdated: applyShapeUpdateWithHistory,
        onShapePreviewed: previewShapeUpdate,
        onShapeContextMenu: options.emitShapeContextMenu,
    });

    watch(options.annotationTool, (tool) => {
        if (!isSelectionInteractionTool(tool)) {
            shapeComposable.selectShape(null);
            shapeComposable.focusShape(null);
        }
    });

    function getShapeAnnotationCommentSummaries() {
        return shapeComposable.getAllShapes().map((shape, index) => toShapeAnnotationCommentSummary(shape, index));
    }

    /**
     * Sidebar shape rows carry the same external identity the store bound for
     * the shape, never a canonical `appAnnotationId`. Both sides therefore
     * resolve through the application, and an unresolvable row matches nothing.
     */
    function findShapeForAnnotationComment(comment: IAnnotationCommentSummary) {
        if (comment.source !== 'shape') {
            return null;
        }
        const application = options.annotationApplication.value;
        const annotationId = application.annotationIdForSummary(comment);
        if (!annotationId) {
            return null;
        }
        return shapeComposable.getAllShapes().find(shape => (
            application.annotationIdForShape(shape) === annotationId
        )) ?? null;
    }

    return {
        shapeComposable,
        selectedShapeCommands,
        applyShapeUpdateWithHistory,
        handleShapeCreated,
        getShapeAnnotationCommentSummaries,
        findShapeForAnnotationComment,
    };
};
