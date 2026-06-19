import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { toFreeTextNoteMarkerRect } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import type { IPdfNativeFreeTextNote } from '@contracts/electronApiDocuments';
import { parsePageIndex } from '@contracts/pageNumbers';
import type {
    INativePdfMutationBuildResult,
    INativePdfMutationPlanCommonInput,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationPlanTypes';

export function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && Boolean(comment.hasNote)
        && Boolean(normalizeMarkerRect(comment.markerRect))
        && (subtype === 'freetext' || subtype === 'typewriter');
}

export function toNativeFreeTextNote(comment: IAnnotationCommentSummary): IPdfNativeFreeTextNote | null {
    const markerRect = toFreeTextNoteMarkerRect(comment.markerRect);
    const stableKey = comment.stableKey?.trim();
    const pageIndex = parsePageIndex(comment.pageIndex);
    if (!markerRect || !stableKey || pageIndex === null) {
        return null;
    }

    return {
        pageIndex,
        stableKey,
        text: comment.text ?? '',
        markerRect,
        author: comment.author ?? null,
        color: comment.color ?? null,
        createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
            ? Math.trunc(comment.createdAt)
            : null,
    };
}

export interface IBuildNativeFreeTextNotesForSaveInput extends INativePdfMutationPlanCommonInput {annotationCommentsSnapshot: IAnnotationCommentSummary[];}

export function buildNativeFreeTextNotesForSave(
    opts: IBuildNativeFreeTextNotesForSaveInput,
): INativePdfMutationBuildResult<IPdfNativeFreeTextNote[]> {
    const skip = (reason: string, details: Record<string, unknown> = {}) => {
        return {
            value: null,
            skipEvents: [{
                event: 'Skipped native FreeText note save fast path',
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
    if (opts.includeManagedShapesForLiveSource) {
        return skip('managed-shapes-require-materialization');
    }
    if (opts.forceRewrite) {
        return skip('rewrite-forced');
    }
    const candidates = opts.annotationCommentsSnapshot
        .filter(isReplayableEditorOnlyFreeTextNote)
        .flatMap((comment) => {
            const note = toNativeFreeTextNote(comment);
            return note ? [note] : [];
        });
    if (candidates.length === 0) {
        return skip('no-replayable-editor-free-text-notes');
    }

    const plan = opts.annotationSavePlan;
    if (plan.route !== 'source-replay') {
        return skip('annotation-save-route-not-source-replay', {
            route: plan.route,
            reason: plan.reason,
        });
    }

    const notesByStableKey = new Map<string, IPdfNativeFreeTextNote>();
    for (const note of candidates) {
        const existing = notesByStableKey.get(note.stableKey);
        if (existing) {
            if (
                existing.text !== note.text
                || existing.pageIndex !== note.pageIndex
                || existing.createdAt !== note.createdAt
            ) {
                return skip('conflicting-native-free-text-note-aliases', {stableKey: note.stableKey});
            }
            continue;
        }
        notesByStableKey.set(note.stableKey, note);
    }

    return {
        value: Array.from(notesByStableKey.values()),
        skipEvents: [],
    };
}
