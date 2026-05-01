import type { IAnnotationCommentSummary } from '@app/types/annotations';

export interface ICommentQueryMatchPart {
    text: string;
    match: boolean;
}

function containsWord(text: string, word: string) {
    return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

export function isTextNoteComment(comment: IAnnotationCommentSummary) {
    if (comment.hasNote === true) {
        return true;
    }

    const subtype = (comment.subtype ?? '').toLowerCase();
    const label = (comment.kindLabel ?? '').toLowerCase();

    return (
        subtype.includes('popup')
        || subtype.includes('text')
        || subtype.includes('note')
        || containsWord(label, 'note')
        || containsWord(label, 'comment')
        || containsWord(label, 'sticky')
    );
}

export function compareAnnotationCommentSummaries(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    if (left.pageIndex !== right.pageIndex) {
        return left.pageIndex - right.pageIndex;
    }

    const leftSort = typeof left.sortIndex === 'number' ? left.sortIndex : null;
    const rightSort = typeof right.sortIndex === 'number' ? right.sortIndex : null;

    if (leftSort !== null && rightSort !== null && leftSort !== rightSort) {
        return leftSort - rightSort;
    }

    if (leftSort !== null && rightSort === null) {
        return -1;
    }

    if (leftSort === null && rightSort !== null) {
        return 1;
    }

    const leftModified = left.modifiedAt ?? 0;
    const rightModified = right.modifiedAt ?? 0;
    if (leftModified !== rightModified) {
        return rightModified - leftModified;
    }

    return left.stableKey.localeCompare(right.stableKey);
}

export function compareComments(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    return compareAnnotationCommentSummaries(left, right);
}

export function matchesCommentQuery(
    comment: IAnnotationCommentSummary,
    normalizedQuery: string,
    fallbackAuthor?: string | null,
) {
    if (!normalizedQuery) {
        return true;
    }

    const author = comment.author?.trim() || fallbackAuthor?.trim() || '';

    return (
        comment.text.toLowerCase().includes(normalizedQuery)
        || (comment.kindLabel ?? '').toLowerCase().includes(normalizedQuery)
        || author.toLowerCase().includes(normalizedQuery)
        || `p${comment.pageNumber}`.includes(normalizedQuery)
    );
}

export function splitByQueryMatches(text: string, normalizedQuery: string): ICommentQueryMatchPart[] {
    if (!normalizedQuery) {
        return [{
            text,
            match: false,
        }];
    }

    if (!text) {
        return [{
            text,
            match: false,
        }];
    }

    const loweredText = text.toLowerCase();
    const parts: ICommentQueryMatchPart[] = [];
    const queryLength = normalizedQuery.length;
    let cursor = 0;

    while (cursor < text.length) {
        const matchIndex = loweredText.indexOf(normalizedQuery, cursor);
        if (matchIndex === -1) {
            parts.push({
                text: text.slice(cursor),
                match: false,
            });
            break;
        }

        if (matchIndex > cursor) {
            parts.push({
                text: text.slice(cursor, matchIndex),
                match: false,
            });
        }

        parts.push({
            text: text.slice(matchIndex, matchIndex + queryLength),
            match: true,
        });

        cursor = matchIndex + queryLength;
    }

    return parts.length ? parts : [{
        text,
        match: false,
    }];
}
