import {
    describe,
    expect,
    it,
} from 'vitest';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';

describe('workspace viewer zoom state', () => {
    it('derives compatibility modes from one authoritative discriminated state', () => {
        const state = useWorkspaceViewerShellState({
            zoom: 1.5,
            effectiveZoom: 1.5,
            zoomMode: 'fit-width',
            fitMode: 'height',
            viewMode: 'single',
            showSidebar: false,
            continuousScroll: true,
        });

        expect(state.zoomState.value).toEqual({
            kind: 'fit',
            axis: 'width',
        });
        expect(state.fitMode.value).toBe('width');

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
});
