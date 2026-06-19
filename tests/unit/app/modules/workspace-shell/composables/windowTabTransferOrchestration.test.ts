import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import { collectLayoutPaneOrder } from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';

function createTab(id: string): ITab {
    return {
        id,
        fileName: `${id}.pdf`,
        originalPath: `/tmp/${id}.pdf`,
        isDirty: false,
        isDjvu: false,
    };
}

describe('window tab transfer orchestration helpers', () => {
    it('collects pane order by stable layout traversal', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.6,
            first: {
                type: 'leaf',
                paneId: 'pane-left',
            },
            second: {
                type: 'split',
                id: 'nested',
                orientation: 'vertical',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    paneId: 'pane-top-right',
                },
                second: {
                    type: 'leaf',
                    paneId: 'pane-bottom-right',
                },
            },
        };

        expect(collectLayoutPaneOrder(layout)).toEqual([
            'pane-left',
            'pane-top-right',
            'pane-bottom-right',
        ]);
    });

    it('collects merge tab order by layout order and tab order inside each pane', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: 'pane-a',
            },
            second: {
                type: 'leaf',
                paneId: 'pane-b',
            },
        };

        const panes: IEditorPaneState[] = [
            {
                paneId: 'pane-a',
                tabIds: [
                    'tab-1',
                    'tab-2',
                ],
                activeTabId: 'tab-1',
            },
            {
                paneId: 'pane-b',
                tabIds: ['tab-3'],
                activeTabId: 'tab-3',
            },
        ];

        const tabs: ITab[] = [
            createTab('tab-1'),
            createTab('tab-2'),
            createTab('tab-3'),
            createTab('tab-detached'),
        ];

        expect(collectMergeTabOrder(layout, panes, tabs)).toEqual([
            'tab-1',
            'tab-2',
            'tab-3',
            'tab-detached',
        ]);
    });

    it('requires electron bridge and empty-source state before closing source window', () => {
        expect(shouldCloseSourceWindowAfterTransfer(1, true)).toBe(true);
        expect(shouldCloseSourceWindowAfterTransfer(0, true)).toBe(true);
        expect(shouldCloseSourceWindowAfterTransfer(2, true)).toBe(false);
        expect(shouldCloseSourceWindowAfterTransfer(1, false)).toBe(false);
    });
});
