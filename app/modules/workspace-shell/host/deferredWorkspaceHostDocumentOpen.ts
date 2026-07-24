import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { TTabUpdate } from '@app/types/tabs';
import type { IWorkspaceDocumentTransaction } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

export type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';

export interface IDocumentOpenTransactionRun {
    sessionTransaction: IWorkspaceDocumentTransaction;
    action: string;
    target: TTabUpdate | null;
    seededTabHint: boolean;
}

export function shouldSeedPendingTabHint({
    target,
    hasWorkspaceOpenedDocument,
    hasWorkspaceSessionOpenedDocument,
}: {
    target: TTabUpdate | null | undefined;
    hasWorkspaceOpenedDocument: boolean;
    hasWorkspaceSessionOpenedDocument: boolean;
}) {
    return Boolean(
        target
        && !hasWorkspaceOpenedDocument
        && !hasWorkspaceSessionOpenedDocument,
    );
}

/**
 * Keeps the host's provisional open-surface identity aligned with the viewer.
 * Electron transactions may use a managed working-copy ref, while geometry
 * prevalidation and the mounted viewer are keyed by the canonical original
 * path. Choosing the transaction ref here would force `claim()` to supersede
 * the generation that owns the opening frame.
 */
export function resolveOpenSurfaceDocumentId(
    target: TTabUpdate | null,
    transactionDocumentRef: TDocumentRef | null,
    fallbackId: string,
) {
    return String(target?.originalPath ?? transactionDocumentRef ?? fallbackId);
}

export function resolvePreparedPdfOpeningGeometry(
    documentId: string,
    geometry: IPdfOpeningGeometry | null | undefined,
) {
    if (!geometry || documentId.length === 0) {
        return null;
    }
    return Object.freeze({
        documentId,
        ...geometry,
    });
}

/**
 * A prepared frame can only be transferred synchronously when its canonical
 * viewer owner is already mounted. Callers must not `await` an already-ready
 * owner check: that microtask gap leaves the outgoing empty surface observable
 * after a Recent-file click and lets immediate navigation commands overtake the
 * document-open transaction.
 */
export function shouldWaitForPreparedOpeningOwner(
    hasPreparedOpeningGeometry: boolean,
    ownerMounted: boolean,
) {
    return hasPreparedOpeningGeometry && !ownerMounted;
}

export function canBeginDocumentOpenSynchronously(
    action: string,
    hasPreparedOpeningGeometry: boolean,
    ownerMounted: boolean,
) {
    return action === 'openRecentFromPlaceholder'
        && hasPreparedOpeningGeometry
        && ownerMounted;
}

export function resolveDocumentOpenRunResult<T>(
    result: T | false,
    reachedTerminalState: boolean,
) {
    return result !== false && reachedTerminalState
        ? result
        : false;
}
