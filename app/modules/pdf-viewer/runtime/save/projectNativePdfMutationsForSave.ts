import type {INativeAppendSaveRoute} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

export type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

/** Consumes a classified grant; violations are programmer errors, never alternate routes. */
export function projectNativePdfMutationsForSave(route: INativeAppendSaveRoute) {
    if (route.replayableAnnotationMutationsAllowed && route.annotationRoute.route !== 'source-replay') {
        throw new Error(`Native annotation replay was granted on the ${route.annotationRoute.route} route`);
    }
    const projection = route.nativeMutationProjection;
    if (Object.keys(projection.mutations).length === 0) {
        throw new Error('Native append was granted without a mutation program');
    }
    if (
        !route.replayableAnnotationMutationsAllowed
        && (
            projection.noteTextUpdates.length > 0
            || projection.freeTextNotes.length > 0
            || projection.annotationDeletes.length > 0
        )
    ) {
        throw new Error('Native annotation mutations were projected without a source-replay grant');
    }
    if (!route.metadataMutationsAllowed && (projection.hasMetadataMutations || projection.hasShapeMutations)) {
        throw new Error('Structured native mutations were projected without capability');
    }
    return projection;
}
