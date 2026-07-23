import type { TDocumentRef } from '@contracts/documentRef';

// Owner readiness is deliberately not an eligibility input: the serialized
// open path requests the workspace mount and awaits the owner itself, so an
// early command queues instead of dying. A row is ineligible only while its
// own document already has an active open transaction.
export function isRecentOpenCommandEligible(input: {
    activeOpenDocumentRef: TDocumentRef | null;
    documentRef: TDocumentRef;
}) {
    return input.activeOpenDocumentRef !== input.documentRef;
}
