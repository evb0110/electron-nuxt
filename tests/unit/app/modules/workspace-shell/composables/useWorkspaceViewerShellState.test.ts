import {
    describe,
    expect,
    it,
} from 'vitest';
import { createRangePageSelection } from '@contracts/pageNumbers';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';

describe('workspace viewer shell state', () => {
    it('derives compatibility modes from one authoritative discriminated state', () => {
        const state = useWorkspaceViewerShellState({
            surfaceMode: 'reader',
            currentPage: 42,
            zoom: 1.5,
            effectiveZoom: 1.5,
            zoomMode: 'fit-width',
            fitMode: 'height',
            viewMode: 'single',
            showSidebar: false,
            sidebarTab: 'search',
            sidebarWidth: 396,
            continuousScroll: true,
        });

        expect(state.zoomState.value).toEqual({
            kind: 'fit',
            axis: 'width',
        });
        expect(state.fitMode.value).toBe('width');
        expect(state.sidebarTab.value).toBe('search');
        expect(state.currentPage.value).toBe(42);

        state.zoomMode.value = 'custom';
        state.zoom.value = 2;
        expect(state.zoomState.value).toEqual({
            kind: 'custom',
            scale: 2,
        });

        state.fitMode.value = 'height';
        expect(state.zoomMode.value).toBe('custom');
        state.zoomMode.value = 'fit-height';
        expect(state.zoomState.value).toEqual({
            kind: 'fit',
            axis: 'height',
        });
    });

    it('keeps the last bounded legacy mirror for an oversized compact selection', () => {
        const state = useWorkspaceViewerShellState();
        state.totalPages.value = 200_000;
        state.setSelectedThumbnailPages([
            2,
            4,
        ]);
        const selection = createRangePageSelection(200_000, 2, 100_002);

        state.setSelectedPageSelection(selection);

        expect(state.selectedPageSelection.value).toEqual(selection);
        expect(state.selectedThumbnailPages.value).toEqual([
            2,
            4,
        ]);
    });
});
