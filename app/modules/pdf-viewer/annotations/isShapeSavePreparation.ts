import type { IShapeAnnotation } from '@app/types/annotations';

/**
 * A save's claim on the shape layer, bound to the store and save frontier that
 * were live when the save started. Priming can only reconcile persistence
 * identity, rollback conditionally removes that metadata without touching
 * authored state, and the clean mark is refused once a replacement store owns
 * the viewer — otherwise a save of the previous document would declare the
 * current one's shapes saved.
 */
export interface IShapeSavePreparation {
    primePersistedShapes: (shapes: IShapeAnnotation[]) => boolean;
    rollback: () => boolean;
    markSaved: () => boolean;
}

/** The prepared save token crosses the workspace expose boundary as `unknown`. */
export function isShapeSavePreparation(value: unknown): value is IShapeSavePreparation {
    return typeof value === 'object'
        && value !== null
        && 'rollback' in value
        && typeof value.rollback === 'function'
        && 'markSaved' in value
        && typeof value.markSaved === 'function';
}
