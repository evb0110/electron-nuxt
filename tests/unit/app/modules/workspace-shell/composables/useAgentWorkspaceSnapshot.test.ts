import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IEditorPaneState } from '@app/types/editorPanes';
import type { ITab } from '@app/types/tabs';
import { cast } from '@tests/helpers/cast';

function createWorkspace(overrides: Partial<ReturnType<IWorkspaceExpose['getToolbarSnapshot']>>) {
    return cast<IWorkspaceExpose>({
        getToolbarSnapshot: () => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            ...overrides,
        }),
        handleGoToPage: vi.fn(),
    });
}

describe('buildAgentWorkspaceSnapshot', () => {
    it('serializes panes, tabs, layout, and document preparation recommendations', () => {
        const panes = ref<IEditorPaneState[]>([
            {
                paneId: 'pane-left',
                tabIds: [
                    'tab-pdf',
                    'tab-djvu',
                ],
                activeTabId: 'tab-pdf',
            },
            {
                paneId: 'pane-right',
                tabIds: ['tab-image'],
                activeTabId: 'tab-image',
            },
        ]);
        const tabs = ref<ITab[]>([
            {
                id: 'tab-pdf',
                fileName: 'Grammar.pdf',
                originalPath: '/tmp/Grammar.pdf',
                isDirty: false,
                isDjvu: false,
            },
            {
                id: 'tab-djvu',
                fileName: 'Reader.djvu',
                originalPath: '/tmp/Reader.djvu',
                isDirty: false,
                isDjvu: true,
            },
            {
                id: 'tab-image',
                fileName: 'scan.png',
                originalPath: '/tmp/scan.png',
                isDirty: false,
                isDjvu: false,
            },
        ]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>([
            [
                'tab-pdf',
                createWorkspace({
                    hasPdf: true,
                    currentPage: 12,
                    totalPages: 80,
                }),
            ],
            [
                'tab-djvu',
                createWorkspace({
                    isDjvuMode: true,
                    currentPage: 3,
                    totalPages: 9,
                }),
            ],
        ]));
        const layout = ref({
            type: 'split',
            id: 'split-root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: 'pane-left',
            },
            second: {
                type: 'leaf',
                paneId: 'pane-right',
            },
        } as const);

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout,
            activePaneId: ref('pane-left'),
            activeTabId: ref('tab-pdf'),
            workspaceRefs,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.includes(tabId)) ?? null,
        });

        expect(snapshot.activePaneId).toBe('pane-left');
        expect(snapshot.panes).toEqual([
            {
                paneId: 'pane-left',
                tabIds: [
                    'tab-pdf',
                    'tab-djvu',
                ],
                activeTabId: 'tab-pdf',
            },
            {
                paneId: 'pane-right',
                tabIds: ['tab-image'],
                activeTabId: 'tab-image',
            },
        ]);

        const pdfTab = snapshot.tabs.find(tab => tab.tabId === 'tab-pdf');
        expect(pdfTab?.kind).toBe('pdf');
        expect(pdfTab?.currentPage).toBe(12);
        expect(pdfTab?.readiness.ocr?.status).toBe('unknown');
        expect(pdfTab?.readiness.recommendations.map(item => item.id)).toEqual(['ocr_all_pages']);

        const djvuTab = snapshot.tabs.find(tab => tab.tabId === 'tab-djvu');
        expect(djvuTab?.kind).toBe('djvu');
        expect(djvuTab?.readiness.recommendations.map(item => item.id)).toEqual(['convert_to_pdf']);

        const imageTab = snapshot.tabs.find(tab => tab.tabId === 'tab-image');
        expect(imageTab?.kind).toBe('image');
        expect(imageTab?.workspaceAttached).toBe(false);
        expect(imageTab?.readiness.recommendations.map(item => item.id)).toEqual(['convert_to_pdf']);
    });
});
