import {
    areDocumentRevisionInfosEqual,
    areTabViewSessionStatesEqual,
    areWorkspaceToolbarSnapshotsEqual,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTransaction,
    IWorkspacePendingCloseDecision,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';

function strictEquals(first: unknown, second: unknown) {
    return first === second;
}

function areIdentityFieldsEqual(
    first: IWorkspaceDocumentIdentity,
    second: IWorkspaceDocumentIdentity,
) {
    return first.documentSessionKey === second.documentSessionKey
        && first.documentInstanceId === second.documentInstanceId
        && first.documentRef === second.documentRef
        && first.originalPath === second.originalPath
        && first.workingCopyPath === second.workingCopyPath
        && first.fileName === second.fileName
        && first.isDjvu === second.isDjvu
        && areDocumentRevisionInfosEqual(first.revisionInfo, second.revisionInfo);
}

function areTransactionsEqual(
    first: IWorkspaceDocumentTransaction | null,
    second: IWorkspaceDocumentTransaction | null,
) {
    if (first === second) {
        return true;
    }
    if (!first || !second) {
        return false;
    }
    return first.id === second.id
        && first.tabId === second.tabId
        && first.kind === second.kind
        && first.documentRef === second.documentRef
        && first.startedAt === second.startedAt
        && first.persist === second.persist;
}

function areCommandTargetsEqual(
    first: TWorkspaceCommandTarget,
    second: TWorkspaceCommandTarget,
) {
    if (
        first.tabId !== second.tabId
        || first.sessionId !== second.sessionId
        || first.documentRef !== second.documentRef
        || first.documentBackend !== second.documentBackend
        || first.documentInstanceId !== second.documentInstanceId
        || first.documentRevisionToken !== second.documentRevisionToken
    ) {
        return false;
    }
    if (first.kind === 'transaction' || second.kind === 'transaction') {
        return first.kind === 'transaction'
            && second.kind === 'transaction'
            && first.transactionId === second.transactionId;
    }
    return first.sessionRevision === second.sessionRevision;
}

function arePendingCloseDecisionsEqual(
    first: IWorkspacePendingCloseDecision | null,
    second: IWorkspacePendingCloseDecision | null,
) {
    if (first === second) {
        return true;
    }
    if (!first || !second) {
        return false;
    }
    return first.persist === second.persist
        && areCommandTargetsEqual(first.target, second.target);
}

// Field-wise comparison keyed over the snapshot type replaces serializing two
// full snapshots per published record; the typed map fails compilation when a
// new snapshot field lacks a comparator, so updates cannot be silently missed.
// (No `-?` modifier: tsgo 7 stops correlating the map's call signatures with it,
// and every snapshot field is required anyway.)
const sessionSnapshotFieldComparators: {
    [K in keyof IWorkspaceDocumentSnapshot]: (
        first: IWorkspaceDocumentSnapshot[K],
        second: IWorkspaceDocumentSnapshot[K],
    ) => boolean;
} = {
    tabId: strictEquals,
    sessionId: strictEquals,
    sessionRevision: strictEquals,
    phase: strictEquals,
    identity: areIdentityFieldsEqual,
    activeTransaction: areTransactionsEqual,
    mounted: strictEquals,
    toolbarSnapshot: areWorkspaceToolbarSnapshotsEqual,
    viewState: areTabViewSessionStatesEqual,
    dirty: strictEquals,
    closeable: strictEquals,
    pendingDocumentPath: strictEquals,
    pendingClose: arePendingCloseDecisionsEqual,
};

const sessionSnapshotFieldKeys = Object.keys(sessionSnapshotFieldComparators) as Array<keyof IWorkspaceDocumentSnapshot>;

function isSessionSnapshotFieldEqual<K extends keyof IWorkspaceDocumentSnapshot>(
    key: K,
    first: IWorkspaceDocumentSnapshot,
    second: IWorkspaceDocumentSnapshot,
) {
    return sessionSnapshotFieldComparators[key](first[key], second[key]);
}

export function areSessionSnapshotsEqual(
    first: IWorkspaceDocumentSnapshot,
    second: IWorkspaceDocumentSnapshot,
) {
    return sessionSnapshotFieldKeys.every(key => isSessionSnapshotFieldEqual(key, first, second));
}
