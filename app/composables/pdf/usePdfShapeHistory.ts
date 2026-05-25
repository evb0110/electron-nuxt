import type { IShapeAnnotation } from '@app/types/annotations';
import {
    cloneShapePoints,
    cloneShapeStrokes,
} from '@app/composables/pdf/pdfShapeStrokes';

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
    registerCommand: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
    addShape: (shape: IShapeAnnotation) => void;
    updateShape: (shapeId: string, shape: IShapeAnnotation) => void;
    deleteShape: (shapeId: string) => void;
    selectShape: (shapeId: string) => void;
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
            },
            undo: () => {
                options.updateShape(previousShape.id, previousShape);
                options.selectShape(previousShape.id);
                options.markModified();
            },
        });
    }

    function handleShapeCreated(shape: IShapeAnnotation) {
        options.markModified();

        options.registerCommand({
            cmd: () => {
                options.addShape(shape);
                options.markModified();
            },
            undo: () => {
                options.deleteShape(shape.id);
                options.markModified();
            },
        });
    }

    return {
        applyShapeUpdateWithHistory,
        handleShapeCreated,
    };
}
