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
import type { IRecentFile } from '@contracts/shared';
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
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Previous.pdf',
            originalPath: '/tmp/Previous.pdf',
            timestamp: Date.UTC(2026, 4, 31),
        }]);

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout,
            activePaneId: ref('pane-left'),
            activeTabId: ref('tab-pdf'),
            recentFiles,
            recentFilesResolved: ref(true),
            workspaceRefs,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.includes(tabId)) ?? null,
        });

        expect(snapshot.activePaneId).toBe('pane-left');
        expect(snapshot.summary).toMatchObject({
            mode: 'open-document',
            documentCount: 3,
            recentFileCount: 1,
            recentFilesResolved: true,
            activeDocument: {
                tabId: 'tab-pdf',
                kind: 'pdf',
                originalPath: '/tmp/Grammar.pdf',
            },
        });
        expect(snapshot.recentFiles).toEqual([{
            fileName: 'Previous.pdf',
            originalPath: '/tmp/Previous.pdf',
            kind: 'pdf',
            openedAt: '2026-05-31T00:00:00.000Z',
        }]);
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

    it('distinguishes an empty attached tab from an open document and exposes recent files as metadata', () => {
        const panes = ref<IEditorPaneState[]>([{
            paneId: 'pane-start',
            tabIds: ['tab-empty'],
            activeTabId: 'tab-empty',
        }]);
        const tabs = ref<ITab[]>([{
            id: 'tab-empty',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]);
        const workspaceRefs = ref(new Map<string, IWorkspaceExpose>([[
            'tab-empty',
            createWorkspace({}),
        ]]));
        const recentFiles = ref<IRecentFile[]>([{
            fileName: 'Recent.djvu',
            originalPath: '/tmp/Recent.djvu',
            timestamp: Date.UTC(2026, 5, 1),
            fileSize: 1234,
        }]);

        const snapshot = buildAgentWorkspaceSnapshot({
            panes,
            tabs,
            layout: ref(null),
            activePaneId: ref('pane-start'),
            activeTabId: ref('tab-empty'),
            recentFiles,
            recentFilesResolved: ref(true),
            workspaceRefs,
            getPaneByTabId: tabId => panes.value.find(pane => pane.tabIds.includes(tabId)) ?? null,
        });

        expect(snapshot.summary).toEqual({
            mode: 'empty-workspace',
            activeDocument: null,
            documentCount: 0,
            recentFileCount: 1,
            recentFilesResolved: true,
        });
        expect(snapshot.tabs).toEqual([expect.objectContaining({
            tabId: 'tab-empty',
            kind: 'empty',
            workspaceAttached: true,
            readiness: expect.objectContaining({ status: 'empty' }),
        })]);
        expect(snapshot.recentFiles).toEqual([{
            fileName: 'Recent.djvu',
            originalPath: '/tmp/Recent.djvu',
            kind: 'djvu',
            openedAt: '2026-06-01T00:00:00.000Z',
            fileSize: 1234,
        }]);
    });
});
