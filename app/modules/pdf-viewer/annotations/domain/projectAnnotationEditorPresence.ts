import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

export function projectAnnotationEditorPresence(
    entity: AnnotationEntity,
    presentExternalIds: ReadonlySet<string>,
    changedExternalIds?: ReadonlySet<string>,
): AnnotationEntity | null {
    if (entity.kind === 'shape') {
        return null;
    }
    const externalIds = [
        entity.identity.pdfRef,
        entity.identity.pdfName,
        entity.identity.pdfjsUid,
        entity.identity.elementId,
    ].filter((candidate): candidate is string => Boolean(candidate));
    const present = externalIds.some(candidate => presentExternalIds.has(candidate));
    const changedDuringReplay = externalIds.some(candidate => changedExternalIds?.has(candidate));
    const shouldRestore = present && entity.deleted;
    // An empty editor snapshot is only evidence of a transient removal when
    // the editor identity actually changed during this replay. The layer is
    // rebuilt asynchronously, so the first post-replay snapshot can be empty
    // even while a restored annotation is still on its way back. Persisted
    // entities are never deleted from presence alone.
    const shouldDeleteTransient = (
        !present
        && entity.persistedRevision < 0
        && !entity.deleted
        && changedDuringReplay
    );
    if (!shouldRestore && !shouldDeleteTransient) {
        return null;
    }
    return {
        ...entity,
        deleted: !present,
        revision: entity.revision + 1,
        modifiedAt: entity.modifiedAt,
    };
}
