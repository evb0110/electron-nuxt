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
    // Only a present-before, absent-after identity is evidence that this replay
    // removed the editor. A saved deletion being restored is absent in both
    // snapshots while PDF.js rebuilds it, so it must remain live here.
    const shouldDeleteTransient = (
        !present
        && entity.persistedRevision < 0
        && !entity.deleted
        && changedDuringReplay
    );
    const shouldDeletePersistedReplay = (
        !present
        && entity.persistedRevision >= 0
        && !entity.deleted
        && changedDuringReplay
    );
    if (!shouldRestore && !shouldDeleteTransient && !shouldDeletePersistedReplay) {
        return null;
    }
    return {
        ...entity,
        deleted: !present,
        revision: entity.revision + 1,
        modifiedAt: entity.modifiedAt,
    };
}
