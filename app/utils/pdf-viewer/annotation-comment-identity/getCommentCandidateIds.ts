import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { uniq } from 'es-toolkit/array';

function parseStableKeyCandidates(stableKey: string | null | undefined) {
    if (!stableKey) {
        return [];
    }

    const normalized = stableKey.trim();
    if (!normalized) {
        return [];
    }

    const uidMatch = normalized.match(/^uid:\d+:(.+)$/);
    if (uidMatch?.[1]) {
        return [uidMatch[1]];
    }

    const annotationMatch = normalized.match(/^ann:\d+:(.+)$/);
    if (annotationMatch?.[1]) {
        return [annotationMatch[1]];
    }

    const sourceMatch = normalized.match(/^src:[^:]+:\d+:(.+)$/);
    if (sourceMatch?.[1]) {
        return [sourceMatch[1]];
    }

    return [];
}

export function getCommentCandidateIds(comment: IAnnotationCommentSummary) {
    return uniq([
        ...parseStableKeyCandidates(comment.stableKey),
        comment.uid,
        comment.annotationId,
        comment.id,
    ].filter((id): id is string => typeof id === 'string' && id.length > 0));
}
