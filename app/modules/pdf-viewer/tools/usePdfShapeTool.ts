import type {
    ComputedRef,
    Ref,
} from 'vue';
import { useAnnotationShapes } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { toShapeAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary';
import { usePdfShapeHistory } from '@app/modules/pdf-viewer/tools/usePdfShapeHistory';
import type { IPdfAppAnnotationHistoryCommand } from '@app/modules/pdf-viewer/tools/usePdfShapeHistory';
import { usePdfSelectedShapeCommands } from '@app/modules/pdf-viewer/tools/usePdfSelectedShapeCommands';
import { usePdfShapeContext } from '@app/modules/pdf-viewer/tools/usePdfShapeContext';
import { isSelectionInteractionTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionInteractionTool';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';

interface IUsePdfShapeToolOptions {
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    isAnySaving: Ref<boolean>;
    registerHistoryCommand: (command: IPdfAppAnnotationHistoryCommand) => void;
    markModified: () => void;
    emitShapeContextMenu: (payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) => void;
    getDeletedShapeHandler: () => ((shape: IShapeAnnotation) => void) | null;
    getShapeCommentsChangedHandler: () => (() => void) | null;
}

export function usePdfShapeTool(options: IUsePdfShapeToolOptions) {
    const shapeComposable = useAnnotationShapes();

    const {
        applyShapeUpdateWithHistory,
        handleShapeCreated,
    } = usePdfShapeHistory({
        registerCommand: options.registerHistoryCommand,
        addShape: shapeComposable.addShape,
        updateShape: shapeComposable.updateShape,
        deleteShape: shapeComposable.deleteShapeByReference,
        selectShape: shapeComposable.selectShape,
        handleDeletedShape: (shape) => options.getDeletedShapeHandler()?.(shape),
        notifyShapeCommentsChanged: () => options.getShapeCommentsChangedHandler()?.(),
        markModified: options.markModified,
    });

    const selectedShapeCommands = usePdfSelectedShapeCommands({
        selectedShapeId: shapeComposable.selectedShapeId,
        hasShapes: shapeComposable.hasShapes,
        isAnySaving: options.isAnySaving,
        getShapeById: shapeComposable.getShapeById,
        selectShape: shapeComposable.selectShape,
        updateShape: shapeComposable.updateShape,
        deleteShape: shapeComposable.deleteShape,
        deleteShapeByReference: shapeComposable.deleteShapeByReference,
        addShape: shapeComposable.addShape,
        applyShapeUpdateWithHistory,
        handleDeletedShape: (shape) => options.getDeletedShapeHandler()?.(shape),
        registerHistoryCommand: options.registerHistoryCommand,
        notifyShapeCommentsChanged: () => options.getShapeCommentsChangedHandler()?.(),
        markModified: options.markModified,
    });

    usePdfShapeContext({
        shapeComposable,
        annotationTool: options.annotationTool,
        annotationSettings: options.annotationSettings,
        onShapeCreated: handleShapeCreated,
        onShapeUpdated: applyShapeUpdateWithHistory,
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

    function findShapeForAnnotationComment(comment: IAnnotationCommentSummary) {
        if (comment.source !== 'shape') {
            return null;
        }
        return shapeComposable.getAllShapes().find((shape) => {
            const summary = toShapeAnnotationCommentSummary(shape);
            return (
                summary.stableKey === comment.stableKey
                || summary.id === comment.id
                || (summary.annotationId && summary.annotationId === comment.annotationId)
            );
        }) ?? null;
    }

    return {
        shapeComposable,
        selectedShapeCommands,
        applyShapeUpdateWithHistory,
        handleShapeCreated,
        getShapeAnnotationCommentSummaries,
        findShapeForAnnotationComment,
    };
}
