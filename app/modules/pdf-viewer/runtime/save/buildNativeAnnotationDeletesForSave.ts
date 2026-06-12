import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import type { IPdfNativeAnnotationDelete } from '@contracts/electronApiDocuments';
import { isReplayableEditorOnlyFreeTextNote } from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import type {
    INativePdfMutationBuildResult,
    INativePdfMutationPlanCommonInput,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationPlanTypes';

function parseAnnotationRefFromStableKey(stableKey: string) {
    const match = stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu);
    return parsePdfJsAnnotationRef(match?.[1]);
}

function resolveNativeAnnotationDeleteRef(comment: IAnnotationCommentSummary) {
    return parseAnnotationRefFromStableKey(comment.stableKey)
        ?? parsePdfJsAnnotationRef(comment.annotationId)
        ?? parsePdfJsAnnotationRef(comment.uid)
        ?? parsePdfJsAnnotationRef(comment.id);
}

export interface IBuildNativeAnnotationDeletesForSaveInput extends INativePdfMutationPlanCommonInput {}

export function buildNativeAnnotationDeletesForSave(
    opts: IBuildNativeAnnotationDeletesForSaveInput,
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

    if (!opts.pendingDeletes?.length) {
        return {
            value: [],
            skipEvents: [],
        };
    }
    if (opts.mode !== 'save') {
        return skip('not-save-mode', {mode: opts.mode});
    }
    if (!opts.hasNativePdfMutationCapability) {
        return skip('native-save-capability-unavailable');
    }
    if (opts.includeManagedShapesForLiveSource) {
        return skip('managed-shapes-require-materialization');
    }
    if (opts.forceRewrite) {
        return skip('rewrite-forced');
    }
    const plan = opts.annotationSavePlan;
    if (plan.route !== 'source-replay') {
        return skip('annotation-save-route-not-source-replay', {
            route: plan.route,
            reason: plan.reason,
        });
    }

    const deletesByRef = new Map<string, IPdfNativeAnnotationDelete>();
    const deletesByStableKey = new Map<string, IPdfNativeAnnotationDelete>();
    for (const comment of opts.pendingDeletes) {
        const targetRef = resolveNativeAnnotationDeleteRef(comment);
        const stableKey = comment.stableKey?.trim();
        if (
            !targetRef
            && stableKey
            && isReplayableEditorOnlyFreeTextNote(comment)
        ) {
            const existing = deletesByStableKey.get(stableKey);
            if (existing) {
                if (existing.pageIndex !== comment.pageIndex) {
                    return skip('conflicting-native-delete-pages', {stableKey});
                }
                continue;
            }
            deletesByStableKey.set(stableKey, {
                pageIndex: comment.pageIndex,
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
            || !Number.isSafeInteger(comment.pageIndex)
            || comment.pageIndex < 0
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
            pageIndex: comment.pageIndex,
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
