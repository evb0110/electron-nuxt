import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/parsePdfAnnotationStableKey';
import type { IPdfNativeAnnotationDelete } from '@contracts/electronApiDocuments';
import { parsePageIndex } from '@contracts/pageNumbers';
import { isReplayableEditorOnlyFreeTextNote } from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import type { INativePdfMutationBuildResult } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';

function parseAnnotationRefFromStableKey(stableKey: string) {
    return parsePdfAnnotationStableKeyRef(stableKey)?.ref ?? null;
}

function resolveNativeAnnotationDeleteRef(comment: IAnnotationCommentSummary) {
    return parseAnnotationRefFromStableKey(comment.stableKey)
        ?? parsePdfJsAnnotationRef(comment.annotationId)
        ?? parsePdfJsAnnotationRef(comment.uid)
        ?? parsePdfJsAnnotationRef(comment.id);
}

/** Reachable only through a native-append grant whose annotation route is source-replay. */
export function buildNativeAnnotationDeletesForSave(
    opts: {pendingDeletes: readonly IAnnotationCommentSummary[]},
): INativePdfMutationBuildResult<IPdfNativeAnnotationDelete[]> {
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            value: null,
            skipEvents: [{
                event: 'Skipped native annotation delete fast path',
                reason,
                details,
            }],
        };
    };

    const deletesByRef = new Map<string, IPdfNativeAnnotationDelete>();
    const deletesByStableKey = new Map<string, IPdfNativeAnnotationDelete>();
    for (const comment of opts.pendingDeletes) {
        const targetRef = resolveNativeAnnotationDeleteRef(comment);
        const stableKey = comment.stableKey?.trim();
        const pageIndex = parsePageIndex(comment.pageIndex);
        if (
            !targetRef
            && stableKey
            && isReplayableEditorOnlyFreeTextNote(comment)
        ) {
            if (pageIndex === null) {
                return skip('pending-delete-not-native-eligible', {stableKey});
            }
            const existing = deletesByStableKey.get(stableKey);
            if (existing) {
                if (existing.pageIndex !== pageIndex) {
                    return skip('conflicting-native-delete-pages', {stableKey});
                }
                continue;
            }
            deletesByStableKey.set(stableKey, {
                pageIndex,
                stableKey,
                createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
                    ? Math.trunc(comment.createdAt)
                    : null,
            });
            continue;
        }
        if (
            !targetRef
            || targetRef.generationNumber > 65_535
            || pageIndex === null
        ) {
            return skip('pending-delete-not-native-eligible', {
                stableKey: comment.stableKey,
                source: comment.source,
                subtype: comment.subtype ?? null,
                annotationId: comment.annotationId ?? null,
                targetRef,
            });
        }

        const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
        const deleteRequest = {
            pageIndex,
            objectNumber: targetRef.objectNumber,
            generationNumber: targetRef.generationNumber,
        };
        const existing = deletesByRef.get(refKey);
        if (existing) {
            if (existing.pageIndex !== deleteRequest.pageIndex) {
                return skip('conflicting-native-delete-pages', {
                    stableKey: comment.stableKey,
                    objectNumber: targetRef.objectNumber,
                    generationNumber: targetRef.generationNumber,
                });
            }
            continue;
        }
        deletesByRef.set(refKey, deleteRequest);
    }

    return {
        value: [
            ...Array.from(deletesByRef.values()),
            ...Array.from(deletesByStableKey.values()),
        ],
        skipEvents: [],
    };
}
