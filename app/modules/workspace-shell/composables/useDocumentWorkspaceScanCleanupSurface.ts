import {useDocumentWorkspaceSurfaceMode} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSurfaceMode';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/public/runtime';
import type {IWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

interface IDocumentWorkspaceScanCleanupSurfaceOptions {
    documentSession: IWorkspaceDocumentController | null;
    initialViewState: ITabViewSessionState | null;
    closeAllDropdowns: () => void;
    readDocumentKey: () => string | null | undefined;
}

export const useDocumentWorkspaceScanCleanupSurface = (
    options: IDocumentWorkspaceScanCleanupSurfaceOptions,
) => {
    const {
        documentSession,
        initialViewState,
    } = options;
    const surface = useDocumentWorkspaceSurfaceMode({
        initialScanCleanup: documentSession?.snapshot.value.viewState.scanCleanup
            ?? initialViewState?.scanCleanup
            ?? null,
        initialSurfaceMode: documentSession?.snapshot.value.viewState.surfaceMode
            ?? initialViewState?.surfaceMode
            ?? 'reader',
        applyViewState: documentSession
            ? updates => documentSession.applyViewState({
                ...documentSession.snapshot.value.viewState,
                ...updates,
            })
            : undefined,
        readScanCleanup: documentSession
            ? () => documentSession.snapshot.value.viewState.scanCleanup ?? null
            : undefined,
        readSurfaceMode: documentSession
            ? () => documentSession.snapshot.value.viewState.surfaceMode
            : undefined,
        clearScanCleanupViewState: documentSession
            ? () => {
                const {
                    scanCleanup: _scanCleanup,
                    ...viewState
                } = documentSession.snapshot.value.viewState;
                documentSession.applyViewState(viewState);
            }
            : undefined,
    });

    function discardScanCleanupState() {
        surface.discardScanCleanupSessionState();
        discardScanCleanupDocumentState(options.readDocumentKey());
    }

    function openScanCleanup() {
        options.closeAllDropdowns();
        surface.openScanCleanup();
    }

    function closeScanCleanup() {
        surface.closeScanCleanup();
        discardScanCleanupState();
    }

    return {
        ...surface,
        closeScanCleanup,
        discardScanCleanupState,
        openScanCleanup,
    };
};
