import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    recoverScanCleanupWorkspaceForDocument,
    resolveScanCleanupEntryViewState,
} from '@app/modules/workspace-shell/composables/useScanCleanupRunCoordinator';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

function viewState(overrides: Partial<ITabViewSessionState> = {}): ITabViewSessionState {
    return {
        continuousScroll: true,
        effectiveZoom: 1,
        fitMode: 'width',
        showSidebar: false,
        surfaceMode: 'reader',
        viewMode: 'single',
        zoom: 1,
        zoomMode: 'custom',
        ...overrides,
    };
}

describe('resolveScanCleanupEntryViewState', () => {
    it('drops stale cleanup selection when entering from the reader', () => {
        expect(resolveScanCleanupEntryViewState(viewState({
            currentPage: 4,
            scanCleanup: {
                previewPage: 17,
                previewViewMode: 'cleaned',
            },
            surfaceMode: 'reader',
        }))).toEqual({
            continuousScroll: true,
            currentPage: 4,
            effectiveZoom: 1,
            fitMode: 'width',
            showSidebar: false,
            surfaceMode: 'scan-cleanup',
            viewMode: 'single',
            zoom: 1,
            zoomMode: 'custom',
        });
    });

    it('preserves the live cleanup session when merely activating its tab', () => {
        const state = viewState({
            currentPage: 4,
            scanCleanup: {
                previewPage: 17,
                previewViewMode: 'cleaned',
            },
            surfaceMode: 'scan-cleanup',
        });

        expect(resolveScanCleanupEntryViewState(state)).toBe(state);
    });

    it('recovers a hidden owner by preserving its cleanup state and activating its tab', async () => {
        const cleanupViewState = viewState({
            currentPage: 4,
            scanCleanup: {
                ownerId: 'stable-hidden-owner',
                previewPage: 17,
                previewViewMode: 'cleaned',
            },
            surfaceMode: 'scan-cleanup',
        });
        const applyViewState = vi.fn();
        const activateTab = vi.fn();
        const session = {
            applyViewState,
            snapshot: {value: {
                identity: {
                    documentRef: '/managed/book.pdf',
                    originalPath: '/source/book.pdf',
                    workingCopyPath: '/managed/book.pdf',
                },
                viewState: cleanupViewState,
            }},
        };

        await expect(recoverScanCleanupWorkspaceForDocument(
            '/source/book.pdf',
            {'hidden-tab': session as never},
            activateTab,
        )).resolves.toBe(true);

        expect(applyViewState).toHaveBeenCalledWith(cleanupViewState);
        expect(activateTab).toHaveBeenCalledWith('hidden-tab');
    });

    it('reports an owner as unrecoverable when its document session is gone', async () => {
        await expect(recoverScanCleanupWorkspaceForDocument(
            '/source/closed.pdf',
            {},
            vi.fn(),
        )).resolves.toBe(false);
    });
});
