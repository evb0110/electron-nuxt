import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

export function createTabViewSessionState(snapshot: IWorkspaceToolbarSnapshot): ITabViewSessionState {
    return {
        currentPage: Math.max(1, Math.trunc(snapshot.currentPage)),
        zoom: snapshot.zoom,
        effectiveZoom: snapshot.effectiveZoom,
        zoomMode: snapshot.zoomMode,
        fitMode: snapshot.fitMode,
        viewMode: snapshot.viewMode,
        showSidebar: snapshot.showSidebar,
        sidebarTab: snapshot.sidebarTab ?? 'thumbnails',
        sidebarWidth: snapshot.sidebarWidth ?? 272,
        continuousScroll: snapshot.continuousScroll,
    };
}
