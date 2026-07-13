import type { TDocumentRef } from '@contracts/documentRef';

export function isRecentOpenCommandEligible(input: {
    activeOpenDocumentRef: TDocumentRef | null;
    documentRef: TDocumentRef;
    ownerReady: boolean;
}) {
    return input.ownerReady && input.activeOpenDocumentRef !== input.documentRef;
}
