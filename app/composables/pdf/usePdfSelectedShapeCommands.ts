import type { Ref } from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import { cloneShape } from '@app/composables/pdf/usePdfShapeHistory';
import { BrowserLogger } from '@app/utils/browser-logger';

export function usePdfSelectedShapeCommands(options: {
    selectedShapeId: Ref<string | null>;
    hasShapes: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    getShapeById: (id: string) => IShapeAnnotation | null;
    selectShape: (id: string | null) => void;
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    deleteShape: (id: string) => void;
    addShape: (shape: IShapeAnnotation) => void;
    applyShapeUpdateWithHistory: (previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) => void;
    refreshDeletedEmbeddedShape: (shape: IShapeAnnotation) => void;
    registerHistoryCommand: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
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

        const nextShape: IShapeAnnotation = cloneShape({
            ...previousShape,
            ...updates,
        });

        options.updateShape(id, updates);
        options.applyShapeUpdateWithHistory(cloneShape(previousShape), nextShape);
    }

    function deleteSelectedShape() {
        if (options.isAnySaving.value) {
            BrowserLogger.debug('pdf-shapes', 'Ignoring delete while save is in flight');
            return;
        }

        const id = options.selectedShapeId.value;
        if (!id) {
            return;
        }

        const deletedShape = options.getShapeById(id);
        if (!deletedShape) {
            return;
        }

        BrowserLogger.debug('pdf-shapes', 'Deleting selected shape from viewer', () => ({
            id,
            source: deletedShape.source,
            annotationId: deletedShape.annotationId ?? null,
            stableKey: deletedShape.stableKey ?? null,
            color: deletedShape.color,
            hasShapes: options.hasShapes.value,
        }));

        options.deleteShape(id);
        options.refreshDeletedEmbeddedShape(deletedShape);
        options.markModified();

        options.registerHistoryCommand({
            cmd: () => {
                options.deleteShape(id);
                options.refreshDeletedEmbeddedShape(deletedShape);
                options.markModified();
            },
            undo: () => {
                options.addShape(deletedShape);
                options.selectShape(id);
                options.markModified();
            },
        });
    }

    return {
        getSelectedShape,
        clearSelectedShape,
        updateShape: updateSelectedShape,
        deleteSelectedShape,
    };
}
