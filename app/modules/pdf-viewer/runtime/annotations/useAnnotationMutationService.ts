import { syncPdfjsCommentMarkerAnchor } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import type {
    IAnnotationMoveMarkerInput,
    IAnnotationMutationContext,
    IAnnotationMutationService,
    IAnnotationUpdateColorInput,
    IAnnotationUpdateCommentInput,
    IAnnotationUpdateMetadataInput,
    IUseAnnotationMutationServiceOptions,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationService.types';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IAnnotationMutationVisualEffect,
    IAnnotationMutationVisualEffectsState,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';

function hasTargetValue(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.length > 0;
}

function createAnnotationMutationVisualEffectsState(): IAnnotationMutationVisualEffectsState {
    const version = ref(0);
    const effects = ref<readonly IAnnotationMutationVisualEffect[]>([]);
    let nextEffectId = 1;
    return {
        version,
        effects,
        enqueue: (effect) => {
            effects.value = [
                ...effects.value,
                {
                    ...effect,
                    id: nextEffectId,
                },
            ];
            nextEffectId += 1;
            version.value += 1;
        },
        consumeThrough: (id) => {
            const remaining = effects.value.filter(effect => effect.id > id);
            if (remaining.length === effects.value.length) {
                return;
            }
            effects.value = remaining;
            version.value += 1;
        },
    };
}

export const useAnnotationMutationService = (
    options: IUseAnnotationMutationServiceOptions,
): IAnnotationMutationService => {
    const visualEffects = createAnnotationMutationVisualEffectsState();

    function runHistoryTransaction<T>(action: () => T) {
        return options.runHistoryTransaction?.(action) ?? action();
    }

    function deleteEmbeddedAnnotationDeferred(comment: IAnnotationCommentSummary) {
        const annotationId = options.resolveCanonicalAnnotationId?.(comment);
        if (!annotationId) {
            return false;
        }
        options.deleteCanonicalAnnotation?.(annotationId);
        return true;
    }

    function updateComment(
        input: IAnnotationUpdateCommentInput,
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(() => {
            const id = options.resolveCanonicalAnnotationId?.(input.comment);
            const updated = options.updateAnnotationComment(input.comment, input.text);
            if (updated && id) options.setCanonicalNoteText?.(id, input.text);
            return updated;
        });
    }

    async function deleteAnnotation(
        input: {
            comment: IAnnotationCommentSummary;
            strategy?: 'auto' | 'pdfjs' | 'embedded-deferred' | 'shape' | 'local-only';
        },
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(async () => {
            const id = options.resolveCanonicalAnnotationId?.(input.comment);
            if (input.strategy === 'local-only') {
                options.markAnnotationLocallyDeleted(input.comment);
                enqueueAnnotationDomRemoval(input.comment);
                return true;
            }
            const deleted = await options.deleteAnnotationComment(input.comment);
            if (deleted) {
                enqueueAnnotationDomRemoval(input.comment);
                if (id) options.deleteCanonicalAnnotation?.(id);
            }
            return deleted;
        });
    }

    function updateColor(
        input: IAnnotationUpdateColorInput,
        _context: IAnnotationMutationContext,
    ) {
        return runHistoryTransaction(() => updateColorInTransaction(input));
    }

    function updateColorInTransaction(input: IAnnotationUpdateColorInput) {
        const result = input.selected === true
            ? options.updateSelectedTextMarkupAnnotationColor(input.color)
            : input.comment
                ? options.updateTextMarkupAnnotationColor(input.comment, input.color)
                : null;
        if (!result?.updated || !result.comment) {
            return result?.updated === true;
        }
        const id = options.resolveCanonicalAnnotationId?.(result.comment);
        if (id) options.setCanonicalColor?.(id, input.color);
        if (result.shouldApplyTextMarkupColor) {
            visualEffects.enqueue({
                kind: 'text-markup-color',
                stableKey: result.comment.stableKey,
                annotationId: result.comment.annotationId,
                pageNumber: result.comment.pageNumber,
                commentSnapshot: result.comment,
                color: input.color,
                sourceColor: result.sourceColor,
            });
        }
        if (result.shouldRefreshPage) {
            visualEffects.enqueue({
                kind: 'render-page-text-markup',
                stableKey: result.comment.stableKey,
                annotationId: result.comment.annotationId,
                pageNumber: result.comment.pageNumber,
                commentSnapshot: result.comment,
            });
        }
        return true;
    }

    function hasPendingAnnotationDomRemoval(comment: IAnnotationCommentSummary) {
        return visualEffects.effects.value.some(effect => (
            effect.kind === 'annotation-dom-removal'
            && (
                (hasTargetValue(comment.stableKey) && effect.stableKey === comment.stableKey)
                || (hasTargetValue(comment.annotationId) && effect.annotationId === comment.annotationId)
            )
        ));
    }

    function enqueueAnnotationDomRemoval(comment: IAnnotationCommentSummary) {
        if (hasPendingAnnotationDomRemoval(comment)) {
            return;
        }
        visualEffects.enqueue({
            kind: 'annotation-dom-removal',
            stableKey: comment.stableKey,
            annotationId: comment.annotationId,
            pageNumber: comment.pageNumber,
            commentSnapshot: comment,
        });
    }

    function enqueueAnnotationDomRemovalByStableKey(stableKey: string) {
        const comment = options.findAnnotationCommentByStableKey?.(stableKey) ?? null;
        if (comment) {
            enqueueAnnotationDomRemoval(comment);
            return;
        }
        visualEffects.enqueue({
            kind: 'annotation-dom-removal',
            stableKey,
            commentSnapshot: null,
        });
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
        return runHistoryTransaction(() => moveMarkerInTransaction(input));
    }

    function moveMarkerInTransaction(input: IAnnotationMoveMarkerInput) {
        const id = options.resolveCanonicalAnnotationId?.(input.comment);
        const moved = options.handleMarkerMove(input.comment, input.rect, {
            markEditorPending: (updated, original, markerRect) => {
                const editor = options.findEditorForComment(updated) ?? options.findEditorForComment(original);
                if (!editor) {
                    return;
                }
                syncPdfjsCommentMarkerAnchor(editor, markerRect);
            },
            markModified: options.markModified,
        });
        if (moved && id) options.moveCanonicalAnchor?.(id, input.rect);
        return moved;
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
        enqueueAnnotationDomRemovalByStableKey(stableKey);
        options.removeAnnotationFromInternalCache(stableKey);
    }

    async function flushForSave() {
        return options.flushAnnotationCommentsForSave();
    }

    return {
        visualEffects,
        updateComment,
        deleteAnnotation,
        updateColor,
        updateMetadata,
        moveMarker,
        restoreAnnotation,
        enqueueAnnotationDomRemoval,
        removeAnnotationFromInternalCache,
        clearPendingMarkerMoves: options.clearPendingMarkerMoves,
        deleteEmbeddedAnnotationDeferred,
        flushForSave,
    };
};
