import type { IAnnotationCommentSummary } from '@app/types/annotations';

export function isNoteEligible(
    subtype: string | null | undefined,
    hasNote?: boolean,
    source?: IAnnotationCommentSummary['source'],
    text?: string,
) {
    if (hasNote === true) {
        return true;
    }

    const normalized = (subtype ?? '').trim().toLowerCase();
    if (
        normalized === 'text'
        || normalized === 'note-linked'
        || normalized === 'freetext'
        || normalized === 'typewriter'
        || normalized === 'note-inline'
        || normalized.includes('popup')
        || normalized.includes('note')
    ) {
        return true;
    }

    return source === 'editor' && typeof text === 'string' && text.trim().length > 0;
}
