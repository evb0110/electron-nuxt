import {useDocumentWorkspaceSurfaceMode} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSurfaceMode';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/public/runtime';
import type {
    IWorkspaceDocumentController,
    IWorkspaceDocumentIdentity,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

/** Scan Cleanup rasterizes the working copy, so only a real source counts. */
function hasScanCleanupSourceDocument(identity: IWorkspaceDocumentIdentity) {
    return Boolean(identity.workingCopyPath ?? identity.documentRef ?? identity.originalPath);
}

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

    // Scan Cleanup edits a document; it cannot outlive one. The final tab keeps
    // its mounted workspace across a close, so without this the surface stays in
    // 'scan-cleanup' over an empty session and reopens there for the next
    // document, replaying a stale page selection against fresh source pages.
    if (documentSession) {
        watch(
            () => hasScanCleanupSourceDocument(documentSession.snapshot.value.identity),
            (hasDocument, hadDocument) => {
                if (hasDocument || hadDocument === false) {
                    return;
                }
                surface.closeScanCleanup();
                discardScanCleanupState();
            },
        );
    }

    function openScanCleanup() {
        options.closeAllDropdowns();
        surface.discardScanCleanupSessionState();
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
