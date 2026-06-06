interface IStartupWorkspacePreloadSignals {
    isDesktopRuntime: boolean;
    isDev: boolean;
    routePreloadWorkspaceShell?: boolean;
}

export function shouldPreloadWorkspaceDuringStartup(signals: IStartupWorkspacePreloadSignals) {
    if (signals.routePreloadWorkspaceShell !== false) {
        return true;
    }

    return signals.isDesktopRuntime && signals.isDev;
}
