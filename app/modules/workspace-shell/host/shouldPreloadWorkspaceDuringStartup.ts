interface IStartupWorkspacePreloadSignals {
    isDesktopRuntime: boolean;
    isDev: boolean;
    routePreloadWorkspaceShell?: boolean;
}

/**
 * Decides whether startup should eagerly import the async DocumentWorkspace chunk.
 * On desktop the startup overlay blocks on this preload, so the heavy workspace shell is
 * parsed before the user can open a document (see `preloadStartupContent` in `app.vue`
 * and the policy overview in `warmupDesktopViewerChunks.ts`). Browser-only routes that
 * never mount the workspace opt out via `preloadWorkspaceShell: false` page meta.
 */
export function shouldPreloadWorkspaceDuringStartup(signals: IStartupWorkspacePreloadSignals) {
    if (signals.isDesktopRuntime || signals.routePreloadWorkspaceShell !== false) {
        return true;
    }

    return false;
}
