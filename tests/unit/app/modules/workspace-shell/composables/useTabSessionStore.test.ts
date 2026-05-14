import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveTabLifecycleStates } from '@app/modules/workspace-shell/composables/useTabSessionStore';
import type { IEditorGroupState } from '@app/types/editorGroups';
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

function group(id: string, activeTabId: string, tabIds: string[]): IEditorGroupState {
    return {
        id,
        activeTabId,
        tabIds,
    };
}

describe('tab session memory policy', () => {
    it('keeps the active tab hot and recent tabs warm in conservative mode', () => {
        const states = resolveTabLifecycleStates({
            tabs: [
                tab('a'),
                tab('b'),
                tab('c'),
                tab('d'),
            ],
            groups: [group('group-1', 'a', [
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
            groups: [
                group('group-1', 'a', [
                    'a',
                    'b',
                ]),
                group('group-2', 'c', ['c']),
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
