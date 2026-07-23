import type {IDocumentWorkspaceProps} from '@app/modules/workspace-shell/composables/createDocumentWorkspaceCommandBindings';
import {useDocumentWorkspaceSurfaceMode} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceSurfaceMode';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/public/runtime';

type TDocumentWorkspaceScanCleanupSurfaceOptions = Pick<
    IDocumentWorkspaceProps,
    'documentSession' | 'initialViewState'
> & {
    closeAllDropdowns: () => void;
    readDocumentKey: () => string | null | undefined;
};

export const useDocumentWorkspaceScanCleanupSurface = (
    options: TDocumentWorkspaceScanCleanupSurfaceOptions,
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
