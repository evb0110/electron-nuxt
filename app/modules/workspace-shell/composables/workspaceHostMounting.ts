import type { ITab } from '@app/types/tabs';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/composables/workspaceTabDocumentHint';

interface IWorkspaceHostSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
}

interface IStartupWorkspacePreloadSignals {
    isDesktopRuntime: boolean;
    isDev: boolean;
    routePreloadWorkspaceShell?: boolean;
}

interface IWorkspaceHostPreloadSignals {
    hasQueuedSplitRestore: boolean;
    hasDocumentHint: boolean;
    isActive: boolean;
    isDev: boolean;
}

export function hasDocumentMountHint(tab: Pick<ITab, 'fileName' | 'originalPath' | 'isDjvu'>) {
    return tabHasDocumentHint(tab);
}

export function shouldPreloadWorkspaceDuringStartup(signals: IStartupWorkspacePreloadSignals) {
    if (signals.routePreloadWorkspaceShell !== false) {
        return true;
    }

    // Cold Vite can full-reload Electron when the workspace chunk first imports.
    // Keep that warmup under the startup overlay instead of after the empty shell paints.
    return signals.isDesktopRuntime && signals.isDev;
}

export function shouldPreloadWorkspaceOnHostMount(signals: IWorkspaceHostPreloadSignals) {
    if (signals.hasQueuedSplitRestore || (signals.isActive && signals.hasDocumentHint)) {
        return true;
    }

    return signals.isActive && !signals.isDev;
}

export function shouldAutoRequestWorkspace(signals: IWorkspaceHostSignals) {
    // Keep empty tabs on the lightweight placeholder so the prerendered shell
    // paints quickly. Split restore still needs an eager workspace because its
    // payload lives in the workspace instance, while document hints wait for
    // activation so hidden tabs do not inflate the full PDF runtime.
    return signals.hasQueuedSplitRestore || (signals.isActive && signals.hasDocumentHint);
}

export function resolveWorkspaceRequestedState(
    currentRequested: boolean,
    signals: IWorkspaceHostSignals,
) {
    if (currentRequested) {
        return true;
    }

    return shouldAutoRequestWorkspace(signals);
}
