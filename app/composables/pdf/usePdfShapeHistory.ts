import type { IShapeAnnotation } from '@app/types/annotations';
import {
    cloneShapePoints,
    cloneShapeStrokes,
} from '@app/composables/pdf/pdfShapeStrokes';

export interface IPdfAppAnnotationHistoryCommand {
    cmd: () => void;
    undo: () => void;
}

export function cloneShape(shape: IShapeAnnotation): IShapeAnnotation {
    return {
        ...shape,
        points: cloneShapePoints(shape.points),
        strokes: cloneShapeStrokes(shape.strokes),
    };
}

function cloneShapeForHistoryComparison(shape: IShapeAnnotation) {
    const {
        createdAt: _createdAt,
        modifiedAt: _modifiedAt,
        ...comparable
    } = cloneShape(shape);
    return comparable;
}

export function usePdfShapeHistory(options: {
    registerCommand: (command: IPdfAppAnnotationHistoryCommand) => void;
    addShape: (shape: IShapeAnnotation) => void;
    updateShape: (shapeId: string, shape: IShapeAnnotation) => void;
    deleteShape: (shape: IShapeAnnotation) => IShapeAnnotation[];
    selectShape: (shapeId: string) => void;
    handleDeletedShape: (shape: IShapeAnnotation) => void;
    notifyShapeCommentsChanged: () => void;
    markModified: () => void;
}) {
    function applyShapeUpdateWithHistory(previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) {
        const hasChanges = JSON.stringify(cloneShapeForHistoryComparison(previousShape))
            !== JSON.stringify(cloneShapeForHistoryComparison(nextShape));
        if (!hasChanges) {
            return;
        }

        options.markModified();

        options.registerCommand({
            cmd: () => {
                options.updateShape(nextShape.id, nextShape);
                options.selectShape(nextShape.id);
                options.markModified();
                options.notifyShapeCommentsChanged();
            },
            undo: () => {
                options.updateShape(previousShape.id, previousShape);
                options.selectShape(previousShape.id);
                options.markModified();
                options.notifyShapeCommentsChanged();
            },
        });
    }

    function handleShapeCreated(shape: IShapeAnnotation) {
        options.markModified();

        options.registerCommand({
            cmd: () => {
                options.addShape(shape);
                options.markModified();
                options.notifyShapeCommentsChanged();
            },
            undo: () => {
                const deletedShapes = options.deleteShape(shape);
                for (const deletedShape of deletedShapes) {
                    options.handleDeletedShape(deletedShape);
                }
                options.markModified();
                options.notifyShapeCommentsChanged();
            },
        });
    }

    return {
        applyShapeUpdateWithHistory,
        handleShapeCreated,
    };
}
