import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    cloneShape,
    type IPdfAppAnnotationHistoryCommand,
} from '@app/composables/pdf/usePdfShapeHistory';
import { BrowserLogger } from '@app/utils/browserLogger';

export function usePdfSelectedShapeCommands(options: {
    selectedShapeId: Ref<string | null>;
    hasShapes: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    getShapeById: (id: string) => IShapeAnnotation | null;
    selectShape: (id: string | null) => void;
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    deleteShape: (id: string) => void;
    deleteShapeByReference: (shape: IShapeAnnotation) => void;
    addShape: (shape: IShapeAnnotation) => void;
    applyShapeUpdateWithHistory: (previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) => void;
    handleDeletedShape: (shape: IShapeAnnotation) => void;
    registerHistoryCommand: (command: IPdfAppAnnotationHistoryCommand) => void;
    notifyShapeCommentsChanged: () => void;
    markModified: () => void;
}) {
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

    function updateSelectedShape(id: string, updates: Partial<IShapeAnnotation>) {
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

        options.updateShape(id, updates);
        options.applyShapeUpdateWithHistory(cloneShape(previousShape), nextShape);
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

        options.deleteShape(id);
        options.handleDeletedShape(deletedShape);
        options.markModified();

        options.registerHistoryCommand({
            cmd: () => {
                options.deleteShapeByReference(deletedShape);
                options.handleDeletedShape(deletedShape);
                options.markModified();
                options.notifyShapeCommentsChanged();
            },
            undo: () => {
                options.addShape(deletedShape);
                options.selectShape(id);
                options.markModified();
                options.notifyShapeCommentsChanged();
            },
        });
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
}
