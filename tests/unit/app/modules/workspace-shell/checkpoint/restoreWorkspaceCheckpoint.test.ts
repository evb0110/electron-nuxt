import { ref } from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { restoreWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint';
import { cast } from '@tests/helpers/cast';

describe('restoreWorkspaceCheckpoint', () => {
    it('reopens a working copy and restores the active page and zoom', async () => {
        const workspace = cast<IWorkspaceExpose>({
            waitForDocumentOpenSettled: vi.fn().mockResolvedValue(undefined),
            handleGoToPage: vi.fn(),
            setCustomZoomFromDisplay: vi.fn(),
            handleFitWidth: vi.fn(),
            handleFitHeight: vi.fn(),
            handleToggleContinuousScroll: vi.fn(),
            handleViewModeFacing: vi.fn(),
            getToolbarSnapshot: () => ({
                continuousScroll: true,
                viewerCapabilities: {
                    continuousScroll: true,
                    viewMode: true,
                },
            }),
            getAutomationStateSnapshot: () => ({
                originalPath: '/documents/draft.pdf',
                workingCopyPath: '/tmp/working/draft.pdf',
            }),
        });
        const tabs = ref([{
            id: 'restored-tab',
            fileName: 'draft.pdf',
            originalPath: '/documents/draft.pdf',
            isDirty: true,
            isDjvu: false,
        }]);
        const workspaceRefs = ref(new Map([[
            'restored-tab',
            workspace,
        ]]));
        const restoreGraph = vi.fn();
        const openPathInReservedTab = vi.fn().mockResolvedValue(true);
        const activateTab = vi.fn();

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: 123,
            activePaneId: 'pane-1',
            activeTabId: 'old-tab',
            layout: {
                type: 'leaf',
                paneId: 'pane-1',
            },
            panes: [{
                paneId: 'pane-1',
                tabIds: ['old-tab'],
                activeTabId: 'old-tab',
            }],
            tabs: [{
                tabId: 'old-tab',
                paneId: 'pane-1',
                fileName: 'draft.pdf',
                sourceRef: '/documents/draft.pdf',
                workingCopyRef: '/tmp/working/draft.pdf',
                isDirty: true,
                isDjvu: false,
                currentPage: 9,
                zoom: 1.4,
                zoomMode: 'custom',
                continuousScroll: false,
                viewMode: 'facing',
            }],
        }, {
            tabs,
            workspaceRefs,
            restoreGraph,
            openPathInReservedTab,
            activateTab,
        });

        expect(restoreGraph).toHaveBeenCalledOnce();
        expect(openPathInReservedTab).toHaveBeenCalledWith('old-tab', '/tmp/working/draft.pdf');
        expect(workspace.handleGoToPage).toHaveBeenCalledWith(9);
        expect(workspace.setCustomZoomFromDisplay).toHaveBeenCalledWith(1.4);
        expect(workspace.handleToggleContinuousScroll).toHaveBeenCalledOnce();
        expect(workspace.handleViewModeFacing).toHaveBeenCalledOnce();
        expect(activateTab).toHaveBeenCalledWith('restored-tab');
    });
});
