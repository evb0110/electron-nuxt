import { ref } from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';

describe('buildWorkspaceCheckpoint', () => {
    it('persists the cleanup surface without copying a document-sized page mapping', () => {
        const toolbar = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            hasPdf: true,
            totalPages: 138_000,
        };
        const viewState = {
            ...createTabViewSessionState(toolbar),
            surfaceMode: 'scan-cleanup' as const,
            scanCleanup: {
                previewPage: 138_000,
                previewViewMode: 'original' as const,
                pageMapping: Object.fromEntries(
                    Array.from(
                        {length: 138_000},
                        (_value, index) => [
                            String(index + 1),
                            [index + 1],
                        ],
                    ),
                ),
            },
        };
        const checkpoint = buildWorkspaceCheckpoint({
            panes: ref([{
                paneId: 'pane-1',
                tabIds: ['tab-1'],
                activeTabId: 'tab-1',
            }]),
            tabs: ref([{
                id: 'tab-1',
                fileName: 'large.pdf',
                originalPath: '/documents/large.pdf',
                isDirty: false,
                isDjvu: false,
            }]),
            layout: ref({
                type: 'leaf',
                paneId: 'pane-1',
            }),
            activePaneId: ref('pane-1'),
            activeTabId: ref('tab-1'),
            workspaceRefs: ref(
                new Map<string, IWorkspaceExpose>(),
            ),
            documentRecordsByTabId: ref({'tab-1': createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'large.pdf',
                    originalPath: '/documents/large.pdf',
                    isDirty: false,
                    isDjvu: false,
                },
                toolbarSnapshot: toolbar,
                viewState,
            })}),
            getPaneByTabId: () => ({
                paneId: 'pane-1',
                tabIds: ['tab-1'],
                activeTabId: 'tab-1',
            }),
        });

        expect(checkpoint.tabs[0]).toMatchObject({surfaceMode: 'scan-cleanup'});
        expect(checkpoint.tabs[0]).not.toHaveProperty('scanCleanup');
        expect(JSON.stringify(checkpoint)).not.toContain('pageMapping');
        expect(JSON.stringify(checkpoint)).not.toContain('138000');
    });
});
