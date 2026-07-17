import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { getWorkspaceViewerCapabilitiesForDocumentType } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

export type TWorkspaceDocumentTabState = Pick<ITab, 'fileName' | 'originalPath' | 'documentInstanceId' | 'isDirty' | 'isDjvu'>;

export interface IWorkspaceDocumentRecord {
    tab: TWorkspaceDocumentTabState;
    documentIdentity: IDocumentRevisionInfo | null;
    toolbarSnapshot: IWorkspaceToolbarSnapshot;
    viewState: ITabViewSessionState;
}

interface ICreateWorkspaceDocumentRecordOptions {
    tab?: TTabUpdate | TWorkspaceDocumentTabState | undefined;
    documentIdentity?: IDocumentRevisionInfo | null | undefined;
    toolbarSnapshot?: Partial<IWorkspaceToolbarSnapshot> | undefined;
    viewState?: ITabViewSessionState | undefined;
}

function normalizeTabState(tab?: TTabUpdate | TWorkspaceDocumentTabState): TWorkspaceDocumentTabState {
    return {
        fileName: tab?.fileName ?? null,
        originalPath: tab?.originalPath ?? null,
        ...(tab?.documentInstanceId === undefined ? {} : {documentInstanceId: tab.documentInstanceId}),
        isDirty: tab?.isDirty ?? false,
        isDjvu: tab?.isDjvu ?? false,
    };
}

function normalizeWorkspaceToolbarSnapshot(
    snapshot: Partial<IWorkspaceToolbarSnapshot> = createDefaultWorkspaceToolbarSnapshot(),
): IWorkspaceToolbarSnapshot {
    const normalized = {
        ...createDefaultWorkspaceToolbarSnapshot(),
        ...snapshot,
        viewerCapabilities: {
            ...createDefaultWorkspaceViewerCapabilities(),
            ...snapshot.viewerCapabilities,
        },
    };

    if (!normalized.isOpeningDocument && normalized.hasPdf) {
        normalized.currentPage = Math.max(1, Math.floor(normalized.currentPage));
        normalized.totalPages = Math.max(normalized.currentPage, Math.floor(normalized.totalPages));
        return normalized;
    }

    if (normalized.isOpeningDocument) {
        normalized.zoom = 1;
        normalized.effectiveZoom = 1;
    }
    normalized.currentPage = 1;
    normalized.totalPages = 0;
    return normalized;
}

export function createWorkspaceDocumentRecord(
    options: ICreateWorkspaceDocumentRecordOptions = {},
): IWorkspaceDocumentRecord {
    const toolbarSnapshot = normalizeWorkspaceToolbarSnapshot(options.toolbarSnapshot);
    return {
        tab: normalizeTabState(options.tab),
        documentIdentity: options.documentIdentity ?? null,
        toolbarSnapshot,
        viewState: options.viewState ?? createTabViewSessionState(toolbarSnapshot),
    };
}

export function createPendingWorkspaceViewState(snapshot: IWorkspaceToolbarSnapshot): ITabViewSessionState {
    return createTabViewSessionState(snapshot);
}

export function createWorkspaceDocumentRecordFromTab(tab: ITab): IWorkspaceDocumentRecord {
    return createWorkspaceDocumentRecord({ tab });
}

export function createPendingWorkspaceDocumentRecord(
    tab: TTabUpdate,
    previousToolbarSnapshot: IWorkspaceToolbarSnapshot = createDefaultWorkspaceToolbarSnapshot(),
    previousViewState: ITabViewSessionState = createTabViewSessionState(previousToolbarSnapshot),
): IWorkspaceDocumentRecord {
    const tabState = normalizeTabState(tab);
    const toolbarSnapshot = normalizeWorkspaceToolbarSnapshot({
        ...previousToolbarSnapshot,
        hasPdf: Boolean(tabState.fileName) || Boolean(tabState.originalPath) || tabState.isDjvu,
        isOpeningDocument: true,
        isDjvuMode: tabState.isDjvu,
        viewerCapabilities: getWorkspaceViewerCapabilitiesForDocumentType(tabState.isDjvu ? 'djvu' : 'pdf'),
    });
    return createWorkspaceDocumentRecord({
        tab: tabState,
        toolbarSnapshot,
        // View preferences survive replacement, but page position belongs to
        // the document being replaced and must not leak into the new open.
        viewState: {
            ...previousViewState,
            currentPage: 1,
        },
    });
}

export function areWorkspaceDocumentRecordsEqual(
    first: IWorkspaceDocumentRecord | null | undefined,
    second: IWorkspaceDocumentRecord | null | undefined,
) {
    return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}
