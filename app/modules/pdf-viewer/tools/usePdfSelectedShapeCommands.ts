import type { Ref } from 'vue';
import type {
    IShapeAnnotation,
    TShapeAnnotationPatch,
} from '@app/types/annotations';
import { cloneShape } from '@app/modules/pdf-viewer/engine/shapes/cloneShape';
import { BrowserLogger } from '@app/utils/browserLogger';

export const usePdfSelectedShapeCommands = (options: {
    selectedShapeId: Ref<string | null>;
    hasShapes: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    getShapeById: (id: string) => IShapeAnnotation | null;
    selectShape: (id: string | null) => void;
    executeShapeUpdate: (previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) => void;
    executeShapeDelete: (shape: IShapeAnnotation) => void;
    notifyShapeCommentsChanged: () => void;
    markModified: () => void;
}) => {
    function getSelectedShape(): IShapeAnnotation | null {
        const id = options.selectedShapeId.value;
        if (!id) {
            return null;
        }
        return options.getShapeById(id);
    }

    function clearSelectedShape() {
        options.selectShape(null);
    }

    function updateSelectedShape(id: string, updates: TShapeAnnotationPatch) {
        const previousShape = options.getShapeById(id);
        if (!previousShape) {
            return;
        }

        const hasChanges = Object.entries(updates).some(
            ([
                key,
                value,
            ]) => previousShape[key as keyof IShapeAnnotation] !== value,
        );
        if (!hasChanges) {
            return;
        }

        const nextShape = cloneShape({
            ...previousShape,
            ...updates,
        });

        options.executeShapeUpdate(cloneShape(previousShape), nextShape);
        options.notifyShapeCommentsChanged();
    }

    function deleteShapeById(id: string) {
        if (options.isAnySaving.value) {
            BrowserLogger.debug('pdf-shapes', 'Ignoring delete while save is in flight');
            return false;
        }

        const deletedShape = options.getShapeById(id);
        if (!deletedShape) {
            return false;
        }

        BrowserLogger.debug('pdf-shapes', 'Deleting shape from viewer', () => ({
            id,
            source: deletedShape.source,
            annotationId: deletedShape.annotationId ?? null,
            stableKey: deletedShape.stableKey ?? null,
            color: deletedShape.color,
            hasShapes: options.hasShapes.value,
        }));

        options.executeShapeDelete(deletedShape);
        options.markModified();
        options.notifyShapeCommentsChanged();

        return true;
    }

    function deleteSelectedShape() {
        const id = options.selectedShapeId.value;
        if (!id) {
            return;
        }

        deleteShapeById(id);
    }

    return {
        getSelectedShape,
        clearSelectedShape,
        updateShape: updateSelectedShape,
        deleteShapeById,
        deleteSelectedShape,
    };
};
