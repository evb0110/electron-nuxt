import type { TDocumentRef } from '@contracts/documentRef';

export function isRecentOpenCommandEligible(input: {
    activeOpenDocumentRef: TDocumentRef | null;
    documentRef: TDocumentRef;
}) {
    return input.activeOpenDocumentRef !== input.documentRef;
}
