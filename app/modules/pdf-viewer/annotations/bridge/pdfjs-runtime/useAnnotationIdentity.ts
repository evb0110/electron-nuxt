// External PDF.js identity decoding. It never owns semantic annotation state.
import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    annotationCommentsMatch,
    commentMergePriority,
    computeSummaryStableKey,
    dedupeAnnotationCommentSummaries,
    mergeCommentSummaries,
    mergeDuplicateCommentSummary,
    normalizeSummaryStableKey,
    toCanonicalStableKey,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';

export const useAnnotationIdentity = (
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>,
) => {
    const editorRuntimeIds = new WeakMap<IPdfjsEditor, string>();
    let editorRuntimeIdCounter = 0;

    function getEditorRuntimeId(editor: IPdfjsEditor, pageIndex: number) {
        let runtimeId = editorRuntimeIds.get(editor);
        if (!runtimeId) {
            editorRuntimeIdCounter += 1;
            runtimeId = `runtime-${pageIndex}-${editorRuntimeIdCounter}`;
            editorRuntimeIds.set(editor, runtimeId);
        }
        return runtimeId;
    }

    function getEditorIdentity(editor: IPdfjsEditor, pageIndex: number) {
        const rawEditorId = typeof editor.id === 'string' || typeof editor.id === 'number'
            ? String(editor.id)
            : '';
        return editor.uid
            ?? editor.annotationElementId
            ?? (rawEditorId ? `editor:${pageIndex}:${rawEditorId}` : null)
            ?? getEditorRuntimeId(editor, pageIndex);
    }

    function toSummaryKey(summary: IAnnotationCommentSummary) {
        return summary.stableKey;
    }

    // Compatibility hooks are intentionally projection-only. Canonical text
    // lives in AnnotationStore; no mutable summary memory is maintained here.
    function rememberSummaryText(_summary: IAnnotationCommentSummary) {}
    function forgetSummaryText(_summary: IAnnotationCommentSummary) {}
    function hydrateSummaryFromMemory(summary: IAnnotationCommentSummary) { return summary; }

    function findCommentByStableKey(stableKey: string) {
        return annotationCommentsCache.value.find(comment => comment.stableKey === stableKey) ?? null;
    }

    function findCommentByAnnotationId(annotationId: string | null | undefined, pageNumber: number | null = null) {
        const normalized = (annotationId ?? '').trim();
        if (!normalized) {
            return null;
        }

        if (Number.isFinite(pageNumber)) {
            const byPage = annotationCommentsCache.value.find(comment => (
                comment.annotationId === normalized
                && comment.pageNumber === pageNumber
            ));
            if (byPage) {
                return byPage;
            }
        }

        return annotationCommentsCache.value.find(comment => comment.annotationId === normalized) ?? null;
    }

    function resolveCommentFromCache(comment: IAnnotationCommentSummary) {
        const direct = findCommentByStableKey(comment.stableKey);
        if (direct) {
            return direct;
        }
        return annotationCommentsCache.value.find(candidate => annotationCommentsMatch(candidate, comment)) ?? null;
    }

    function clearMemory() {}

    return {
        getEditorRuntimeId,
        getEditorIdentity,
        computeSummaryStableKey,
        toCanonicalStableKey,
        normalizeSummaryStableKey,
        compareAnnotationCommentSummaries,
        dedupeAnnotationCommentSummaries,
        commentMergePriority,
        mergeDuplicateCommentSummary,
        mergeCommentSummaries,
        toSummaryKey,
        rememberSummaryText,
        hydrateSummaryFromMemory,
        forgetSummaryText,
        annotationCommentsMatch,
        resolveCommentFromCache,
        findCommentByStableKey,
        findCommentByAnnotationId,
        clearMemory,
    };
};
