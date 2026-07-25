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
    INativeAppendSaveRoute,
    INativePdfMutationProjectionResult,
    INativePdfMutationProjectionInput,
    INativePdfMutationSkipEvent,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

export type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

const NO_NATIVE_MUTATIONS = {
    value: null,
    skipEvents: [],
} as const;

/** Documented precondition of the grant, asserted here instead of re-derived. */
function assertNativeAnnotationReplayGrant(route: INativeAppendSaveRoute) {
    if (route.replayableAnnotationMutationsAllowed && route.annotationRoute.route !== 'source-replay') {
        throw new Error(`Native annotation replay was granted on the ${route.annotationRoute.route} route`);
    }
}

/** Purely projects an immutable serialization program onto the native backend. */
export function projectNativePdfMutationsForSave(
    opts: INativePdfMutationProjectionInput,
): INativePdfMutationProjectionResult {
    assertNativeAnnotationReplayGrant(opts.route);
    const {
        dirtyState,
        documentStructure,
    } = opts;
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

    const replayAllowed = opts.route.replayableAnnotationMutationsAllowed;
    if (!replayAllowed) {
        skipEvents.push({
            event: 'Skipped native PDF annotation replay',
            reason: 'annotation-save-route-not-source-replay',
            details: {
                route: opts.route.annotationRoute.route,
                reason: opts.route.annotationRoute.reason,
            },
        });
    }
    const nativeNoteTextUpdatesResult = replayAllowed && opts.pendingTexts.size
        ? buildNativeNoteTextUpdatesForSave(opts)
        : NO_NATIVE_MUTATIONS;
    skipEvents.push(...nativeNoteTextUpdatesResult.skipEvents);
    const nativeFreeTextNotesResult = replayAllowed
        ? buildNativeFreeTextNotesForSave(opts)
        : NO_NATIVE_MUTATIONS;
    skipEvents.push(...nativeFreeTextNotesResult.skipEvents);
    const nativeAnnotationDeletesResult = replayAllowed
        ? buildNativeAnnotationDeletesForSave(opts)
        : NO_NATIVE_MUTATIONS;
    skipEvents.push(...nativeAnnotationDeletesResult.skipEvents);
    const pendingTextsCoveredByNativeChanges = arePendingTextsCoveredByNativeChanges({
        pendingTexts: opts.pendingTexts,
        nativeNoteTextUpdates: nativeNoteTextUpdatesResult.value,
        nativeFreeTextNotes: nativeFreeTextNotesResult.value,
    });
    const noteTextUpdates = nativeNoteTextUpdatesResult.value ?? [];
    const freeTextNotes = nativeFreeTextNotesResult.value ?? [];
    const annotationDeletes = nativeAnnotationDeletesResult.value ?? [];
    const nativeNoteMutationCount = noteTextUpdates.length + freeTextNotes.length + annotationDeletes.length;
    const pendingDeletesAreFullyCovered = opts.pendingDeletes.length > 0
        && annotationDeletes.length === opts.pendingDeletes.length;
    if (dirtyState.savedPdfjsAnnotationBaselineDirty && !pendingDeletesAreFullyCovered) {
        // A preserved live PDF.js session can hide deleted/undone existing markup
        // outside annotationStorage until PDF.js serializes it.
        return skip('saved-pdfjs-baseline-dirty-requires-materialization');
    }
    const annotationWorkDirty = opts.route.annotationWorkDirty;
    const markup = buildNativeMarkupMutationForSave({
        canonicalComments: opts.canonicalComments,
        annotationWorkDirty,
        markupSubtypeOverrides: opts.markupSubtypeOverrides,
        markupSubtypeHints: opts.markupSubtypeHints,
    });
    const hasMarkupMutations = Boolean(markup);
    if (opts.route.pdfjsMaterializeForced && nativeNoteMutationCount === 0 && !hasMarkupMutations) {
        return skip('pdfjs-materialize-required');
    }
    if (!pendingTextsCoveredByNativeChanges) {
        return skip('pending-texts-not-covered-by-native-mutations');
    }
    if (opts.pendingDeletes.length && annotationDeletes.length !== opts.pendingDeletes.length) {
        return skip('pending-deletes-not-covered-by-native-mutations', {
            requestedDeletes: opts.pendingDeletes.length,
            nativeDeletes: annotationDeletes.length,
        });
    }
    if (dirtyState.hasLivePdfJsAnnotationChanges && nativeNoteMutationCount === 0) {
        return skip('live-pdfjs-annotation-work-not-covered-by-native-mutations');
    }
    if (annotationWorkDirty && nativeNoteMutationCount === 0 && !hasMarkupMutations) {
        return skip('annotation-work-not-covered-by-native-mutations');
    }

    const shapes = buildNativeShapesMutationForSave({
        shapeStateDirty: dirtyState.shapeStateDirty,
        totalPageCount: opts.totalPageCount,
        shapes: opts.shapes,
        deletedAnnotationIds: opts.deletedEmbeddedShapeAnnotationIds,
        deletedStableKeys: opts.deletedEmbeddedShapeStableKeys,
    });
    const hasShapeMutations = Boolean(shapes);
    if (dirtyState.shapeStateDirty && !hasShapeMutations) {
        return skip('shape-payload-unavailable');
    }
    const pageLabels = buildNativePageLabelsMutationForSave({
        pageLabelsDirty: documentStructure.pageLabelsDirty,
        totalPageCount: opts.totalPageCount,
        pageLabelRanges: documentStructure.pageLabelRanges,
    });
    const bookmarks = buildNativeBookmarksMutationForSave({
        bookmarksDirty: documentStructure.bookmarksDirty,
        totalPageCount: opts.totalPageCount,
        bookmarkItems: documentStructure.bookmarkItems,
        untitledBookmarkLabel: documentStructure.untitledBookmarkLabel,
    });
    const hasMetadataMutations = Boolean(pageLabels) || Boolean(bookmarks);
    if ((documentStructure.pageLabelsDirty || documentStructure.bookmarksDirty) && !hasMetadataMutations) {
        return skip('metadata-payload-unavailable');
    }
    if ((hasMetadataMutations || hasShapeMutations) && !opts.route.metadataMutationsAllowed) {
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
