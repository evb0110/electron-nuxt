import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    formatStressAppStateForModel,
    hashStressAppState,
} from '@scripts/stress/stressAppState';
import type { IStressAppState } from '@scripts/stress/stressTypes';

function state(overrides: Partial<IStressAppState> = {}): IStressAppState {
    return {
        tabIds: [
            'tab-1',
            'tab-2',
        ],
        activeTabId: 'tab-2',
        fileName: 'big.pdf',
        currentPage: 12,
        totalPages: 4000,
        zoomPercent: 100,
        viewMode: 'single',
        activeTool: null,
        isDirty: false,
        isOpeningDocument: false,
        hasOpenError: false,
        readiness: 'ready',
        viewerInteractionReady: true,
        visibleDialogs: [],
        visibleToasts: [],
        ...overrides,
    };
}

describe('stress app state', () => {
    it('hashes semantic state and ignores tab ids that change per session', () => {
        const base = hashStressAppState(state());
        expect(hashStressAppState(state({
            tabIds: [
                'x',
                'y',
            ],
            activeTabId: 'y',
        }))).toBe(base);
        expect(hashStressAppState(state({currentPage: 13}))).not.toBe(base);
        expect(hashStressAppState(state({visibleDialogs: ['Error']}))).not.toBe(base);
        expect(hashStressAppState(state({viewerInteractionReady: false}))).toBe(base);
    });

    it('formats a compact description for the model', () => {
        const text = formatStressAppStateForModel(state({
            isDirty: true,
            hasOpenError: true,
            visibleDialogs: ['Open failed'],
            visibleToasts: ['Saved'],
        }));
        expect(text).toContain('document: big.pdf');
        expect(text).toContain('page: 12 of 4000');
        expect(text).toContain('tabs: 2 (active index 1)');
        expect(text).toContain('unsaved changes: yes');
        expect(text).toContain('(open error shown)');
        expect(text).toContain('dialogs: Open failed');
        expect(text).toContain('messages: Saved');
    });
});
