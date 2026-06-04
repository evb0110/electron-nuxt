import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createTabViewSessionState,
    resolveTabLifecycleStates,
} from '@app/modules/workspace-shell/composables/useTabSessionStore';
import type { IEditorPaneState } from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';

function tab(id: string): ITab {
    return {
        id,
        fileName: `${id}.pdf`,
        originalPath: `/docs/${id}.pdf`,
        isDirty: false,
        isDjvu: false,
    };
}

function pane(id: string, activeTabId: string, tabIds: string[]): IEditorPaneState {
    return {
        paneId: id,
        activeTabId,
        tabIds,
    };
}

describe('tab session memory policy', () => {
    it('does not persist document page position in tab view state', () => {
        const state = createTabViewSessionState({
            hasPdf: true,
            isOpeningDocument: false,
            hasOpenError: false,
            isPreparingPrint: false,
            isPreparingCurrentPagePrint: false,
            canSave: true,
            canRepairSave: true,
            canUndo: false,
            canRedo: false,
            canExportDocx: false,
            isSaving: false,
            isSavingAs: false,
            isAnySaving: false,
            isHistoryBusy: false,
            isExportingDocx: false,
            isFitWidthActive: true,
            isFitHeightActive: false,
            showSidebar: false,
            dragMode: false,
            continuousScroll: true,
            isDjvuMode: false,
            isCapturingRegion: false,
            isCropSelecting: false,
            isPlacingPageNote: false,
            zoom: 1,
            effectiveZoom: 1,
            zoomMode: 'fit-width',
            fitMode: 'width',
            viewMode: 'single',
            currentPage: 42,
            totalPages: 100,
        });

        expect(state).not.toHaveProperty('currentPage');
    });

    it('keeps the active tab hot and recent tabs warm in conservative mode', () => {
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                tab('b'),
                tab('c'),
                tab('d'),
            ],
            panes: [pane('pane-1', 'a', [
                'a',
                'b',
                'c',
                'd',
            ])],
            activeTabId: 'a',
            activationOrder: [
                'a',
                'c',
                'b',
                'd',
            ],
            policy: 'conservative',
        });

        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            state.temperature,
        ]))).toEqual({
            a: 'hot',
            b: 'warm',
            c: 'warm',
            d: 'cold',
        });
    });

    it('cools non-active tabs aggressively except visible split panes', () => {
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                tab('b'),
                tab('c'),
            ],
            panes: [
                pane('pane-1', 'a', [
                    'a',
                    'b',
                ]),
                pane('pane-2', 'c', ['c']),
            ],
            activeTabId: 'a',
            activationOrder: [
                'a',
                'b',
                'c',
            ],
            policy: 'aggressive',
        });

        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            state.temperature,
        ]))).toEqual({
            a: 'hot',
            b: 'cold',
            c: 'hot',
        });
    });
});
