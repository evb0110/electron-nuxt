import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/parsePdfAnnotationStableKey';
import { normalizeAnnotationSubtypeToken } from '@app/utils/textNormalization';
import type {
    IPdfNativeFreeTextNote,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type {
    INativePdfMutationBuildResult,
    INativePdfMutationPlanCommonInput,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationPlanTypes';

const NATIVE_NOTE_TEXT_UPDATE_SUBTYPES = new Set([
    'text',
    'popup',
    'note',
    'highlight',
    'underline',
    'strikeout',
    'squiggly',
]);

function parseAnnotationRefFromStableKey(stableKey: string) {
    return parsePdfAnnotationStableKeyRef(stableKey)?.ref ?? null;
}

function resolveNativeNoteTextUpdateRef(stableKey: string, comment: IAnnotationCommentSummary) {
    return parseAnnotationRefFromStableKey(stableKey)
        ?? parseAnnotationRefFromStableKey(comment.stableKey)
        ?? parsePdfJsAnnotationRef(comment.annotationId);
}

function buildNativeNoteTextCommentLookup(comments: IAnnotationCommentSummary[]) {
    const commentsByKey = new Map<string, IAnnotationCommentSummary>();
    const addCommentKey = (key: string | null | undefined, comment: IAnnotationCommentSummary) => {
        const normalized = key?.trim();
        if (normalized && !commentsByKey.has(normalized)) {
            commentsByKey.set(normalized, comment);
        }
    };

    comments.forEach((comment) => {
        addCommentKey(comment.stableKey, comment);
        const normalizedAnnotationId = normalizePdfJsAnnotationId(comment.annotationId);
        addCommentKey(normalizedAnnotationId, comment);
        if (normalizedAnnotationId) {
            addCommentKey(`ann:${comment.pageIndex}:${normalizedAnnotationId}`, comment);
        }
    });

    return commentsByKey;
}

function isNativeNoteTextUpdateSubtype(comment: IAnnotationCommentSummary) {
    const normalizedSubtype = normalizeAnnotationSubtypeToken(comment.subtype);
    return NATIVE_NOTE_TEXT_UPDATE_SUBTYPES.has(normalizedSubtype);
}

export interface IBuildNativeNoteTextUpdatesForSaveInput extends INativePdfMutationPlanCommonInput {annotationCommentsSnapshot: IAnnotationCommentSummary[];}

export function buildNativeNoteTextUpdatesForSave(
    opts: IBuildNativeNoteTextUpdatesForSaveInput,
): INativePdfMutationBuildResult<IPdfNoteTextUpdate[]> {
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            value: null,
            skipEvents: [{
                event: 'Skipped native note-text save fast path',
                reason,
                details,
            }],
        };
    };

    if (opts.mode !== 'save') {
        return skip('not-save-mode', {mode: opts.mode});
    }
    if (!opts.hasNativePdfMutationCapability) {
        return skip('native-save-capability-unavailable');
    }
    if (!opts.pendingTexts?.size) {
        return skip('no-pending-text-updates');
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

    const commentsByStableKey = buildNativeNoteTextCommentLookup(opts.annotationCommentsSnapshot);
    const updatesByRef = new Map<string, IPdfNoteTextUpdate>();
    const updates: IPdfNoteTextUpdate[] = [];
    for (const [
        stableKey,
        text,
    ] of opts.pendingTexts.entries()) {
        const comment = commentsByStableKey.get(stableKey);
        const targetRef = comment ? resolveNativeNoteTextUpdateRef(stableKey, comment) : null;
        if (
            !comment
            || comment.source !== 'pdf'
            || !isNativeNoteTextUpdateSubtype(comment)
            || !targetRef
            || targetRef.generationNumber > 65_535
        ) {
            return skip('pending-text-not-native-eligible', {
                stableKey,
                hasComment: Boolean(comment),
                source: comment?.source ?? null,
                subtype: comment?.subtype ?? null,
                targetRef,
            });
        }
        const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
        const existing = updatesByRef.get(refKey);
        if (existing) {
            if (existing.text !== text) {
                return skip('conflicting-native-note-text-aliases', {
                    stableKey,
                    objectNumber: targetRef.objectNumber,
                    generationNumber: targetRef.generationNumber,
                });
            }
            continue;
        }
        const update = {
            objectNumber: targetRef.objectNumber,
            generationNumber: targetRef.generationNumber,
            text,
        };
        updatesByRef.set(refKey, update);
        updates.push(update);
    }

    return {
        value: updates.length > 0 ? updates : null,
        skipEvents: [],
    };
}

export function arePendingTextsCoveredByNativeChanges(opts: {
    pendingTexts: Map<string, string> | null;
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
    nativeNoteTextUpdates: IPdfNoteTextUpdate[] | null;
    nativeFreeTextNotes: IPdfNativeFreeTextNote[] | null;
}) {
    if (!opts.pendingTexts?.size) {
        return true;
    }

    const freeTextNotesByStableKey = new Map(
        (opts.nativeFreeTextNotes ?? []).map(note => [
            note.stableKey,
            note,
        ]),
    );
    const updateRefs = new Set(
        (opts.nativeNoteTextUpdates ?? []).map(update =>
            `${update.objectNumber}R${update.generationNumber}`,
        ),
    );
    const commentsByStableKey = buildNativeNoteTextCommentLookup(opts.annotationCommentsSnapshot);

    for (const [
        stableKey,
        text,
    ] of opts.pendingTexts.entries()) {
        const freeTextNote = freeTextNotesByStableKey.get(stableKey.trim());
        if (freeTextNote?.text === text) {
            continue;
        }

        const comment = commentsByStableKey.get(stableKey);
        const targetRef = comment ? resolveNativeNoteTextUpdateRef(stableKey, comment) : null;
        if (
            targetRef
            && updateRefs.has(`${targetRef.objectNumber}R${targetRef.generationNumber}`)
        ) {
            continue;
        }

        return false;
    }

    return true;
}
