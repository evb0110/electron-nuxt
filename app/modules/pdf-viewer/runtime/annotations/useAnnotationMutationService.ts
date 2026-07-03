import { syncCommentMarkerAnchorEditor } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/commentMarkerAnchorEditor';
import type {
    IAnnotationMoveMarkerInput,
    IAnnotationMutationContext,
    IAnnotationMutationService,
    IAnnotationPendingEmbeddedTextUpdateInput,
    IAnnotationSuppressionTarget,
    IAnnotationUpdateColorInput,
    IAnnotationUpdateCommentInput,
    IAnnotationUpdateMetadataInput,
    IConsumedAnnotationEmbeddedMutations,
    IUseAnnotationMutationServiceOptions,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationService.types';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createEmptyConsumedEmbeddedMutations(): IConsumedAnnotationEmbeddedMutations {
    return {
        pendingEmbeddedTextUpdates: new Map<string, string>(),
        pendingEmbeddedAnnotationDeletes: [],
        restore: () => undefined,
        commit: () => undefined,
    };
}

function hasTargetValue(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

export const useAnnotationMutationService = (
    options: IUseAnnotationMutationServiceOptions,
): IAnnotationMutationService => {
    const pendingEmbeddedMutationVersion = ref(0);
    const pendingEmbeddedTextUpdates = new Map<string, string>();
    const pendingEmbeddedAnnotationDeletes = new Map<string, IAnnotationCommentSummary>();

    function bumpPendingEmbeddedMutationVersion() {
        pendingEmbeddedMutationVersion.value += 1;
    }

    function resolvePendingEmbeddedTextUpdateKey(input: IAnnotationPendingEmbeddedTextUpdateInput) {
        return input.stableKey ?? input.comment.stableKey;
    }

    function queuePendingEmbeddedTextUpdate(input: IAnnotationPendingEmbeddedTextUpdateInput) {
        const stableKey = resolvePendingEmbeddedTextUpdateKey(input);
        if (!stableKey) {
            return false;
        }
        pendingEmbeddedTextUpdates.set(stableKey, input.text);
        bumpPendingEmbeddedMutationVersion();
        return true;
    }

    function clearPendingEmbeddedTextUpdate(stableKey: string) {
        if (!pendingEmbeddedTextUpdates.delete(stableKey)) {
            return;
        }
        bumpPendingEmbeddedMutationVersion();
    }

    function migratePendingEmbeddedTextUpdate(previousKey: string, nextKey: string) {
        if (!previousKey || !nextKey || previousKey === nextKey) {
            return;
        }
        if (!pendingEmbeddedTextUpdates.has(previousKey)) {
            return;
        }
        const pendingText = pendingEmbeddedTextUpdates.get(previousKey);
        pendingEmbeddedTextUpdates.delete(previousKey);
        if (typeof pendingText === 'string' && !pendingEmbeddedTextUpdates.has(nextKey)) {
            pendingEmbeddedTextUpdates.set(nextKey, pendingText);
        }
        bumpPendingEmbeddedMutationVersion();
    }

    function queuePendingEmbeddedAnnotationDelete(comment: IAnnotationCommentSummary) {
        if (!comment.stableKey) {
            return false;
        }
        pendingEmbeddedAnnotationDeletes.set(comment.stableKey, comment);
        bumpPendingEmbeddedMutationVersion();
        return true;
    }

    function unqueuePendingEmbeddedAnnotationDelete(stableKey: string) {
        if (!pendingEmbeddedAnnotationDeletes.delete(stableKey)) {
            return;
        }
        bumpPendingEmbeddedMutationVersion();
    }

    function getPendingEmbeddedMutationSnapshot() {
        return {
            pendingEmbeddedTextUpdates: new Map(pendingEmbeddedTextUpdates),
            pendingEmbeddedAnnotationDeletes: Array.from(pendingEmbeddedAnnotationDeletes.values()),
        };
    }

    function updateComment(
        input: IAnnotationUpdateCommentInput,
        _context: IAnnotationMutationContext,
    ) {
        return options.updateAnnotationComment(input.comment, input.text);
    }

    async function deleteAnnotation(
        input: {
            comment: IAnnotationCommentSummary;
            strategy?: 'auto' | 'pdfjs' | 'embedded-deferred' | 'shape' | 'local-only';
        },
        _context: IAnnotationMutationContext,
    ) {
        if (input.strategy === 'local-only') {
            options.markAnnotationLocallyDeleted(input.comment);
            return true;
        }
        return options.deleteAnnotationComment(input.comment);
    }

    function updateColor(
        input: IAnnotationUpdateColorInput,
        _context: IAnnotationMutationContext,
    ) {
        if (input.selected === true) {
            return options.updateSelectedTextMarkupAnnotationColor(input.color);
        }
        if (!input.comment) {
            return false;
        }
        return options.updateTextMarkupAnnotationColor(input.comment, input.color);
    }

    function updateMetadata(
        _input: IAnnotationUpdateMetadataInput,
        _context: IAnnotationMutationContext,
    ) {
        return false;
    }

    function moveMarker(
        input: IAnnotationMoveMarkerInput,
        _context: IAnnotationMutationContext,
    ) {
        return options.handleMarkerMove(input.comment, input.rect, {
            markEditorPending: (updated, original, markerRect) => {
                const editor = options.findEditorForComment(updated) ?? options.findEditorForComment(original);
                if (!editor) {
                    return;
                }
                syncCommentMarkerAnchorEditor(editor, markerRect);
                options.addPendingCommentEditorKey(
                    options.getEditorPendingKey(editor, updated.pageIndex),
                );
            },
            markModified: options.markModified,
        });
    }

    function restoreAnnotation(
        comment: IAnnotationCommentSummary,
        _context: IAnnotationMutationContext,
    ) {
        options.restoreAnnotationLocally(comment);
    }

    function removeAnnotationFromInternalCache(
        stableKey: string,
        _context: IAnnotationMutationContext,
    ) {
        options.removeAnnotationFromInternalCache(stableKey);
    }

    function suppressAnnotation(target: IAnnotationSuppressionTarget) {
        const {
            annotationId,
            stableKey,
        } = target;
        if (hasTargetValue(stableKey)) {
            options.suppressAnnotationStableKey(stableKey);
        }
        if (hasTargetValue(annotationId)) {
            options.suppressManagedAnnotationId(annotationId);
        }
    }

    function unsuppressAnnotation(target: IAnnotationSuppressionTarget) {
        const {
            annotationId,
            stableKey,
        } = target;
        if (hasTargetValue(stableKey)) {
            options.unsuppressAnnotationStableKey(stableKey);
        }
        if (hasTargetValue(annotationId)) {
            options.unsuppressManagedAnnotationId(annotationId);
            options.unsuppressCommentAnnotationId(annotationId);
        }
    }

    async function flushForSave() {
        return options.flushAnnotationCommentsForSave();
    }

    function consumePendingEmbeddedMutations() {
        const external = options.consumePendingEmbeddedMutations?.();
        if (external) {
            return external;
        }
        if (pendingEmbeddedTextUpdates.size === 0 && pendingEmbeddedAnnotationDeletes.size === 0) {
            return createEmptyConsumedEmbeddedMutations();
        }
        const consumedTexts = new Map(pendingEmbeddedTextUpdates);
        const consumedDeletes = Array.from(pendingEmbeddedAnnotationDeletes.values());
        pendingEmbeddedTextUpdates.clear();
        pendingEmbeddedAnnotationDeletes.clear();
        bumpPendingEmbeddedMutationVersion();

        let settled = false;
        return {
            pendingEmbeddedTextUpdates: consumedTexts,
            pendingEmbeddedAnnotationDeletes: consumedDeletes,
            restore: () => {
                if (settled) {
                    return;
                }
                settled = true;
                consumedTexts.forEach((text, stableKey) => {
                    if (!pendingEmbeddedTextUpdates.has(stableKey)) {
                        pendingEmbeddedTextUpdates.set(stableKey, text);
                    }
                });
                consumedDeletes.forEach((comment) => {
                    if (!pendingEmbeddedAnnotationDeletes.has(comment.stableKey)) {
                        pendingEmbeddedAnnotationDeletes.set(comment.stableKey, comment);
                    }
                });
                bumpPendingEmbeddedMutationVersion();
            },
            commit: () => {
                settled = true;
            },
        };
    }

    return {
        pendingEmbeddedMutationVersion,
        updateComment,
        deleteAnnotation,
        updateColor,
        updateMetadata,
        moveMarker,
        restoreAnnotation,
        removeAnnotationFromInternalCache,
        clearPendingMarkerMoves: options.clearPendingMarkerMoves,
        suppressAnnotation,
        unsuppressAnnotation,
        queuePendingEmbeddedTextUpdate,
        clearPendingEmbeddedTextUpdate,
        migratePendingEmbeddedTextUpdate,
        queuePendingEmbeddedAnnotationDelete,
        unqueuePendingEmbeddedAnnotationDelete,
        getPendingEmbeddedMutationSnapshot,
        flushForSave,
        consumePendingEmbeddedMutations,
    };
};
