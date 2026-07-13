import { buildNativeAnnotationDeletesForSave } from '@app/modules/pdf-viewer/runtime/save/buildNativeAnnotationDeletesForSave';
import { buildNativeFreeTextNotesForSave } from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import { buildNativeMarkupMutationForSave } from '@app/modules/pdf-viewer/runtime/save/nativeMarkupMutations';
import {
    buildNativeBookmarksMutationForSave,
    buildNativePageLabelsMutationForSave,
} from '@app/modules/pdf-viewer/runtime/save/nativeMetadataMutations';
import {
    arePendingTextsCoveredByNativeChanges,
    buildNativeNoteTextUpdatesForSave,
} from '@app/modules/pdf-viewer/runtime/save/nativeNoteTextUpdates';
import {buildNativeShapesMutationForSave} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';
import type {
    INativePdfMutationProjectionResult,
    INativePdfMutationProjectionInput,
    INativePdfMutationSkipEvent,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

export type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

/** Purely projects an immutable serialization program onto the native backend. */
export function projectNativePdfMutationsForSave(
    opts: INativePdfMutationProjectionInput,
): INativePdfMutationProjectionResult {
    const skipEvents: INativePdfMutationSkipEvent[] = [];
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            projection: null,
            skipEvents: [
                ...skipEvents,
                {
                    event: 'Skipped native PDF mutation save fast path',
                    reason,
                    details,
                },
            ],
        };
    };

    if (opts.mode !== 'save') {
        return skip('not-save-mode', {mode: opts.mode});
    }
    if (!opts.hasNativePdfMutationCapability) {
        return skip('native-save-capability-unavailable');
    }
    if (opts.includeManagedShapesForLiveSource) {
        return skip('managed-shapes-require-materialization');
    }

    const nativeNoteTextUpdatesResult = opts.pendingTexts?.size
        ? buildNativeNoteTextUpdatesForSave(opts)
        : {
            value: null,
            skipEvents: [],
        };
    skipEvents.push(...nativeNoteTextUpdatesResult.skipEvents);
    const nativeFreeTextNotesResult = buildNativeFreeTextNotesForSave(opts);
    skipEvents.push(...nativeFreeTextNotesResult.skipEvents);
    const nativeAnnotationDeletesResult = buildNativeAnnotationDeletesForSave(opts);
    skipEvents.push(...nativeAnnotationDeletesResult.skipEvents);
    const pendingTextsCoveredByNativeChanges = arePendingTextsCoveredByNativeChanges({
        pendingTexts: opts.pendingTexts,
        canonicalComments: opts.canonicalComments,
        nativeNoteTextUpdates: nativeNoteTextUpdatesResult.value,
        nativeFreeTextNotes: nativeFreeTextNotesResult.value,
    });
    const noteTextUpdates = nativeNoteTextUpdatesResult.value ?? [];
    const freeTextNotes = nativeFreeTextNotesResult.value ?? [];
    const annotationDeletes = nativeAnnotationDeletesResult.value ?? [];
    const nativeNoteMutationCount = noteTextUpdates.length + freeTextNotes.length + annotationDeletes.length;
    const pendingDeleteCount = opts.pendingDeletes?.length ?? 0;
    const pendingDeletesAreFullyCovered = pendingDeleteCount > 0
        && annotationDeletes.length === pendingDeleteCount;
    if (opts.savedPdfjsAnnotationBaselineDirty && !pendingDeletesAreFullyCovered) {
        // A preserved live PDF.js session can hide deleted/undone existing markup
        // outside annotationStorage until PDF.js serializes it.
        return skip('saved-pdfjs-baseline-dirty-requires-materialization');
    }
    const annotationWorkDirty = opts.annotationDirty || (opts.hasAnnotationChanges && !opts.shapeStateDirty);
    const markup = buildNativeMarkupMutationForSave({
        canonicalComments: opts.canonicalComments,
        annotationWorkDirty,
        markupSubtypeOverrides: opts.markupSubtypeOverrides,
        markupSubtypeHints: opts.markupSubtypeHints,
    });
    const hasMarkupMutations = Boolean(markup);
    if (opts.forcePdfjsMaterialize && nativeNoteMutationCount === 0 && !hasMarkupMutations) {
        return skip('pdfjs-materialize-required');
    }
    if (opts.forceRewrite) {
        return skip('rewrite-forced');
    }
    if (!pendingTextsCoveredByNativeChanges) {
        return skip('pending-texts-not-covered-by-native-mutations');
    }
    if (opts.pendingDeletes?.length && annotationDeletes.length !== opts.pendingDeletes.length) {
        return skip('pending-deletes-not-covered-by-native-mutations', {
            requestedDeletes: opts.pendingDeletes.length,
            nativeDeletes: annotationDeletes.length,
        });
    }
    if (opts.hasLivePdfJsAnnotationChanges && nativeNoteMutationCount === 0) {
        return skip('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    }
    if (annotationWorkDirty && nativeNoteMutationCount === 0 && !hasMarkupMutations) {
        return skip('annotation-work-not-covered-by-native-mutations');
    }

    const shapes = buildNativeShapesMutationForSave({
        shapeStateDirty: opts.shapeStateDirty,
        totalPageCount: opts.totalPageCount,
        shapes: opts.shapes,
        deletedAnnotationIds: opts.deletedEmbeddedShapeAnnotationIds,
        deletedStableKeys: opts.deletedEmbeddedShapeStableKeys,
    });
    const hasShapeMutations = Boolean(shapes);
    if (opts.shapeStateDirty && !hasShapeMutations) {
        return skip('shape-payload-unavailable');
    }
    const pageLabels = buildNativePageLabelsMutationForSave({
        pageLabelsDirty: opts.pageLabelsDirty,
        totalPageCount: opts.totalPageCount,
        pageLabelRanges: opts.pageLabelRanges,
    });
    const bookmarks = buildNativeBookmarksMutationForSave({
        bookmarksDirty: opts.bookmarksDirty,
        totalPageCount: opts.totalPageCount,
        bookmarkItems: opts.bookmarkItems,
        untitledBookmarkLabel: opts.untitledBookmarkLabel,
    });
    const hasMetadataMutations = Boolean(pageLabels) || Boolean(bookmarks);
    if ((opts.pageLabelsDirty || opts.bookmarksDirty) && !hasMetadataMutations) {
        return skip('metadata-payload-unavailable');
    }
    if ((hasMetadataMutations || hasShapeMutations) && !opts.canPersistNativeMetadataMutations) {
        return skip('native-structured-save-capability-unavailable');
    }
    if (nativeNoteMutationCount === 0 && !hasMetadataMutations && !hasShapeMutations && !hasMarkupMutations) {
        return {
            projection: null,
            skipEvents,
        };
    }

    return {
        projection: {
            canonicalAnnotationProgram: opts.canonicalAnnotationProgram,
            mutations: {
                ...(noteTextUpdates.length > 0 ? {updates: noteTextUpdates} : {}),
                ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
                ...(annotationDeletes.length > 0 ? {deletes: annotationDeletes} : {}),
                ...(pageLabels ? {pageLabels} : {}),
                ...(bookmarks ? {bookmarks} : {}),
                ...(shapes ? {shapes} : {}),
                ...(markup ? {markup} : {}),
            },
            noteTextUpdates,
            freeTextNotes,
            annotationDeletes,
            hasMetadataMutations,
            hasShapeMutations,
            hasMarkupMutations,
            phase: hasMetadataMutations || hasShapeMutations || hasMarkupMutations
                ? 'persist-native-pdf-mutations'
                : annotationDeletes.length
                    ? 'persist-native-annotation-changes'
                    : freeTextNotes.length
                        ? 'persist-native-note-changes'
                        : 'persist-native-note-text-updates',
        },
        skipEvents,
    };
}
