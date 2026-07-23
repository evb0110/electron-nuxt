// @vitest-environment happy-dom
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {useDocumentWorkspaceScanCleanupSurface} from '@app/modules/workspace-shell/composables/useDocumentWorkspaceScanCleanupSurface';
import type {IDocumentWorkspaceProps} from '@app/modules/workspace-shell/composables/createDocumentWorkspaceCommandBindings';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

type TDocumentSession = NonNullable<IDocumentWorkspaceProps['documentSession']>;

function viewState(overrides: Partial<ITabViewSessionState> = {}): ITabViewSessionState {
    return {
        surfaceMode: 'reader',
        zoom: 1,
        effectiveZoom: 1,
        zoomMode: 'custom',
        fitMode: 'width',
        viewMode: 'single',
        showSidebar: false,
        continuousScroll: true,
        ...overrides,
    };
}

describe('useDocumentWorkspaceScanCleanupSurface', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('owns scan-cleanup transitions when no document session is available', () => {
        const closeAllDropdowns = vi.fn();
        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession: null,
            initialViewState: viewState(),
            closeAllDropdowns,
            readDocumentKey: () => null,
        });

        surface.openScanCleanup();
        expect(closeAllDropdowns).toHaveBeenCalledOnce();
        expect(surface.surfaceMode.value).toBe('scan-cleanup');

        surface.closeScanCleanup();
        expect(surface.surfaceMode.value).toBe('reader');
        expect(surface.scanCleanupSessionState.value).toBeNull();
    });

    it('reads, writes, and clears the document session view state', () => {
        const snapshot = ref({
            ...({} as TDocumentSession['snapshot']['value']),
            viewState: viewState({scanCleanup: {
                previewPage: 3,
                previewViewMode: 'cleaned',
            }}),
        });
        const applyViewState = vi.fn((viewState: typeof snapshot.value.viewState) => {
            snapshot.value = {
                ...snapshot.value,
                viewState,
            };
        });
        const documentSession: TDocumentSession = {
            ...({} as TDocumentSession),
            snapshot,
            applyViewState,
        };
        const surface = useDocumentWorkspaceScanCleanupSurface({
            documentSession,
            initialViewState: null,
            closeAllDropdowns: vi.fn(),
            readDocumentKey: () => '/docs/current.pdf',
        });

        expect(surface.scanCleanupSessionState.value?.previewPage).toBe(3);
        surface.openScanCleanup();
        expect(applyViewState).toHaveBeenLastCalledWith({
            ...viewState({scanCleanup: {
                previewPage: 3,
                previewViewMode: 'cleaned',
            }}),
            surfaceMode: 'scan-cleanup',
        });

        surface.discardScanCleanupState();
        expect(applyViewState).toHaveBeenLastCalledWith({
            ...viewState(),
            surfaceMode: 'scan-cleanup',
        });
    });
});
