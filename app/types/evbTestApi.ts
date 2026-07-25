import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IEvbAutomationEvent,
    TEvbAutomationEventListener,
    TEvbAutomationEventPredicate,
    TEvbAutomationEventType,
} from '@app/types/evbAutomationEvents';
import type {
    IWorkspaceAutomationStateSnapshot,
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';

export interface IEvbTestCommandResult<TResult = unknown> {
    called: boolean;
    value: TResult | null;
}

export interface IEvbTestWorkspaceSummary {
    automationStateKeys: string[];
    exposedKeys: string[];
    isActive: boolean;
    tabId: string;
    toolbarSnapshot: IWorkspaceToolbarSnapshot | null;
}

export interface IEvbTestWorkspaceDebugState {
    activeTabId: string | null;
    activeToolbarSnapshot: IWorkspaceToolbarSnapshot | null;
    activeWorkspaceState: IWorkspaceAutomationStateSnapshot | Record<string, never>;
    workspaceCount: number;
    workspaces: IEvbTestWorkspaceSummary[];
}

export interface IEvbTestApi {
    callActiveWorkspaceCommand: <TResult = unknown>(
        commandName: string,
        args?: unknown[],
    ) => Promise<IEvbTestCommandResult<TResult>>;
    collectWorkspaceDebugState: () => IEvbTestWorkspaceDebugState;
    getAutomationEvents: () => IEvbAutomationEvent[];
    getActiveTabId: () => string | null;
    getActiveToolbarSnapshot: () => IWorkspaceToolbarSnapshot | null;
    getActiveWorkspaceHandle: () => IWorkspaceExpose | null;
    isStartupOpenClaimPending: () => boolean;
    onAutomationEvent: (cb: TEvbAutomationEventListener) => () => void;
    openFile: (path: TDocumentRef) => Promise<boolean>;
    openFiles: (paths: TDocumentRef[]) => Promise<void>;
    readActiveWorkspaceStateValues: <TValues extends Record<string, unknown> = Record<string, unknown>>(
        propertyNames: string[],
    ) => TValues;
    waitForAutomationEvent: (
        type: TEvbAutomationEventType,
        predicate?: TEvbAutomationEventPredicate,
        timeoutMs?: number,
    ) => Promise<IEvbAutomationEvent>;
    waitForActiveDocumentOpenSettled: () => Promise<boolean>;
}
