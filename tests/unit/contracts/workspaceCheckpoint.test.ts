import {
    describe,
    expect,
    it,
} from 'vitest';
import { decodeWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';

function createCheckpoint() {
    return {
        version: 1,
        capturedAt: 1_700_000_000_000,
        activePaneId: 'pane-1',
        activeTabId: 'tab-1',
        layout: {
            type: 'leaf',
            paneId: 'pane-1',
        },
        panes: [{
            paneId: 'pane-1',
            tabIds: ['tab-1'],
            activeTabId: 'tab-1',
        }],
        tabs: [{
            tabId: 'tab-1',
            paneId: 'pane-1',
            fileName: 'draft.pdf',
            sourceRef: '/documents/draft.pdf',
            workingCopyRef: '/tmp/working/draft.pdf',
            isDirty: true,
            isDjvu: false,
            currentPage: 7,
            zoom: 1.25,
            zoomMode: 'custom',
        }],
    };
}

describe('decodeWorkspaceCheckpoint', () => {
    it('decodes a versioned pane, tab, document, and view-state snapshot', () => {
        expect(decodeWorkspaceCheckpoint(createCheckpoint())).toEqual(createCheckpoint());
    });

    it.each([
        [
            false,
            'facing',
        ],
        [
            true,
            'single',
        ],
    ] as const)('round-trips scroll and view mode (%s, %s)', (continuousScroll, viewMode) => {
        const base = createCheckpoint();
        const checkpoint = {
            ...base,
            tabs: base.tabs.map(tab => ({
                ...tab,
                continuousScroll,
                viewMode,
            })),
        };

        expect(decodeWorkspaceCheckpoint(checkpoint)).toEqual(checkpoint);
    });

    it.each([
        {
            ...createCheckpoint(),
            version: 2,
        },
        {
            ...createCheckpoint(),
            layout: {
                type: 'split',
                id: 'bad',
                orientation: 'horizontal',
                ratio: 0.5,
            },
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                currentPage: 0,
            }],
        },
        {
            ...createCheckpoint(),
            tabs: [{
                ...createCheckpoint().tabs[0],
                zoomMode: 'page-width',
            }],
        },
    ])('rejects malformed or unsupported checkpoints', (candidate) => {
        expect(decodeWorkspaceCheckpoint(candidate)).toBeNull();
    });
});
