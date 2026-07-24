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
        expect(openPathInReservedTab).toHaveBeenCalledWith('old-tab', {
            kind: 'pdf',
            originalPath: '/documents/draft.pdf',
            workingPath: '/tmp/working/draft.pdf',
        });
        expect(workspace.handleGoToPage).toHaveBeenCalledWith(9);
        expect(workspace.setCustomZoomFromDisplay).toHaveBeenCalledWith(1.4);
        expect(workspace.handleToggleContinuousScroll).toHaveBeenCalledOnce();
        expect(workspace.handleViewModeFacing).toHaveBeenCalledOnce();
        expect(activateTab).toHaveBeenCalledWith('restored-tab');
    });

    it('restores an unsaved generated PDF from its working copy without losing Save As semantics', async () => {
        const workspace = cast<IWorkspaceExpose>({
            waitForDocumentOpenSettled: vi.fn().mockResolvedValue(undefined),
            handleGoToPage: vi.fn(),
            setCustomZoomFromDisplay: vi.fn(),
            handleFitWidth: vi.fn(),
            handleFitHeight: vi.fn(),
            handleToggleContinuousScroll: vi.fn(),
            handleViewModeSingle: vi.fn(),
            handleViewModeFacing: vi.fn(),
            handleViewModeFacingFirstSingle: vi.fn(),
            getToolbarSnapshot: () => ({
                continuousScroll: true,
                viewerCapabilities: {
                    continuousScroll: true,
                    viewMode: true,
                },
            }),
            getAutomationStateSnapshot: () => ({
                originalPath: '/documents/Combined.pdf',
                workingCopyPath: '/tmp/working/Combined.pdf',
            }),
        });
        const openPathInReservedTab = vi.fn().mockResolvedValue(true);

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: 123,
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
                fileName: 'Combined.pdf',
                sourceRef: '/documents/Combined.pdf',
                workingCopyRef: '/tmp/working/Combined.pdf',
                requiresSaveAsOnFirstSave: true,
                isDirty: true,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
            }],
        }, {
            tabs: ref([{
                id: 'tab-1',
                fileName: 'Combined.pdf',
                originalPath: '/documents/Combined.pdf',
                isDirty: true,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>().set('tab-1', workspace)),
            restoreGraph: vi.fn(),
            openPathInReservedTab,
            activateTab: vi.fn(),
        });

        expect(openPathInReservedTab).toHaveBeenCalledWith('tab-1', {
            kind: 'pdf',
            workingPath: '/tmp/working/Combined.pdf',
            originalPath: '/documents/Combined.pdf',
            isGenerated: true,
        });
    });

    it('restores a blank tab without waiting for document visual readiness', async () => {
        const waitForDocumentOpenSettled = vi.fn().mockResolvedValue(undefined);
        const workspace = cast<IWorkspaceExpose>({
            waitForDocumentOpenSettled,
            getAutomationStateSnapshot: () => ({}),
        });
        const activateTab = vi.fn();

        await restoreWorkspaceCheckpoint({
            version: 1,
            capturedAt: 123,
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
                fileName: null,
                sourceRef: null,
                workingCopyRef: null,
                isDirty: false,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
            }],
        }, {
            tabs: ref([{
                id: 'tab-1',
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            }]),
            workspaceRefs: ref(new Map<string, IWorkspaceExpose>().set('tab-1', workspace)),
            restoreGraph: vi.fn(),
            openPathInReservedTab: vi.fn(),
            activateTab,
        });

        expect(waitForDocumentOpenSettled).not.toHaveBeenCalled();
        expect(activateTab).toHaveBeenCalledWith('tab-1');
    });
});
