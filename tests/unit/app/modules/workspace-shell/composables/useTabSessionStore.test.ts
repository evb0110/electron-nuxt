import {
    describe,
    expect,
    it,
} from 'vitest';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/tabs/resolveTabLifecycleStates';
import type { IEditorPaneState } from '@contracts/editorPanes';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
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
    it('persists document page position in tab view state', () => {
        const state = createTabViewSessionState({
            hasPdf: true,
            initialVisualReady: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                sidebar: true,
            },
            isOpeningDocument: false,
            hasOpenError: false,
            isPreparingPrint: false,
            isPreparingCurrentPagePrint: false,
            canSave: true,
            canRepairSave: true,
            canOptimizePdf: true,
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
            sidebarTab: 'search',
            sidebarWidth: 384,
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

        expect(state.currentPage).toBe(42);
        expect(state.sidebarTab).toBe('search');
        expect(state.sidebarWidth).toBe(384);
    });

    it('merges surface mode without changing toolbar-derived reader state', () => {
        const readerState = createTabViewSessionState({
            ...createDefaultWorkspaceToolbarSnapshot(),
            currentPage: 23,
            zoom: 1.8,
            effectiveZoom: 1.8,
            zoomMode: 'custom',
        });
        const cleanupState = createTabViewSessionState({
            ...createDefaultWorkspaceToolbarSnapshot(),
            currentPage: 23,
            zoom: 1.8,
            effectiveZoom: 1.8,
            zoomMode: 'custom',
        }, {
            ...readerState,
            surfaceMode: 'scan-cleanup',
            scanCleanup: {
                previewPage: 17,
                previewViewMode: 'original',
            },
        });

        expect(cleanupState).toMatchObject({
            surfaceMode: 'scan-cleanup',
            currentPage: 23,
            zoom: 1.8,
            effectiveZoom: 1.8,
            zoomMode: 'custom',
            scanCleanup: {
                previewPage: 17,
                previewViewMode: 'original',
            },
        });
        expect(readerState.surfaceMode).toBe('reader');
    });

    it.each<THostResourceTier>([
        'medium',
        'high',
    ])('keeps the active tab hot and two recent tabs warm on the %s tier', (tier) => {
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
            tier,
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
        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            state.viewerResidency,
        ]))).toEqual({
            a: 'active',
            b: 'warm',
            c: 'warm',
            d: 'hibernated',
        });
        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            state.isReclaimCandidate,
        ]))).toEqual({
            a: false,
            b: true,
            c: true,
            d: false,
        });
    });

    it('caps low-tier conservative mode at one inactive warm tab', () => {
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
            tier: 'low',
        });

        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            state.temperature,
        ]))).toEqual({
            a: 'hot',
            b: 'cold',
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
            tier: 'low',
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

    it('keeps dirty inactive tabs warm but not reclaimable', () => {
        const dirtyTab = {
            ...tab('b'),
            isDirty: true,
        };
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                dirtyTab,
                tab('c'),
            ],
            panes: [pane('pane-1', 'a', [
                'a',
                'b',
                'c',
            ])],
            activeTabId: 'a',
            activationOrder: [
                'a',
                'c',
                'b',
            ],
            policy: 'aggressive',
            tier: 'low',
        });

        expect(Object.fromEntries(states.map(state => [
            state.tabId,
            {
                isReclaimCandidate: state.isReclaimCandidate,
                shouldMountHost: state.shouldMountHost,
                temperature: state.temperature,
                viewerResidency: state.viewerResidency,
            },
        ]))).toEqual({
            a: {
                isReclaimCandidate: false,
                shouldMountHost: true,
                temperature: 'hot',
                viewerResidency: 'active',
            },
            b: {
                isReclaimCandidate: false,
                shouldMountHost: true,
                temperature: 'warm',
                viewerResidency: 'warm',
            },
            c: {
                isReclaimCandidate: false,
                shouldMountHost: false,
                temperature: 'cold',
                viewerResidency: 'hibernated',
            },
        });
    });
});
