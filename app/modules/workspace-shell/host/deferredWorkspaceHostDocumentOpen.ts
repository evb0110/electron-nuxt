import type { TDocumentRef } from '@contracts/documentRef';
import type { TTabUpdate } from '@app/types/tabs';
import type {
    IWorkspaceDocumentTransaction,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

export interface IDocumentOpenTransactionRun {
    sessionTransaction: IWorkspaceDocumentTransaction;
    action: string;
    target: TTabUpdate | null;
    seededTabHint: boolean;
}

export interface IDocumentOpenIntent {
    action: string;
    commandTarget?: TWorkspaceCommandTarget | undefined;
    target?: TTabUpdate | null;
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

export function resolveDocumentOpenTransactionKind(action: string): TWorkspaceDocumentTransactionKind {
    return action.toLowerCase().includes('restore') ? 'restore' : 'open';
}

export function resolveTransactionDocumentRef(
    target: TTabUpdate | null,
    fallbackDocumentPath: TDocumentRef | null,
) {
    return target?.originalPath ?? fallbackDocumentPath;
}

export function resolveDocumentOpenRunResult<T>(
    result: T | false,
    reachedTerminalState: boolean,
) {
    return result !== false && reachedTerminalState
        ? result
        : false;
}
