import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolveScanCleanupEntryViewState} from '@app/modules/workspace-shell/composables/useScanCleanupRunCoordinator';
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
});
