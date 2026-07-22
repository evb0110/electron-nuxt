import type {
    IScanCleanupTabSessionState,
    TDocumentSurfaceMode,
} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

interface IUseDocumentWorkspaceSurfaceModeOptions {
    initialScanCleanup: IScanCleanupTabSessionState | null;
    initialSurfaceMode: TDocumentSurfaceMode;
    applyViewState?: ((updates: {
        surfaceMode?: TDocumentSurfaceMode;
        scanCleanup?: IScanCleanupTabSessionState;
    }) => void) | undefined;
    readScanCleanup?: (() => IScanCleanupTabSessionState | null) | undefined;
    readSurfaceMode?: (() => TDocumentSurfaceMode) | undefined;
}

export const useDocumentWorkspaceSurfaceMode = (options: IUseDocumentWorkspaceSurfaceModeOptions) => {
    const localSurfaceMode = ref(options.initialSurfaceMode);
    const localScanCleanupSessionState = ref(options.initialScanCleanup);
    const surfaceMode = computed<TDocumentSurfaceMode>({
        get: () => options.readSurfaceMode?.() ?? localSurfaceMode.value,
        set: (mode) => {
            localSurfaceMode.value = mode;
            options.applyViewState?.({surfaceMode: mode});
        },
    });
    const scanCleanupSessionState = computed(() => options.readScanCleanup?.() ?? localScanCleanupSessionState.value);

    function openScanCleanup() {
        surfaceMode.value = 'scan-cleanup';
    }

    function closeScanCleanup() {
        surfaceMode.value = 'reader';
    }

    function updateScanCleanupSessionState(state: IScanCleanupTabSessionState) {
        localScanCleanupSessionState.value = state;
        options.applyViewState?.({scanCleanup: state});
    }

    return {
        closeScanCleanup,
        openScanCleanup,
        scanCleanupSessionState,
        surfaceMode,
        updateScanCleanupSessionState,
    };
};
