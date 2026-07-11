import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
    watch,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import {
    createDefaultWorkspaceViewerCapabilities,
    type IWorkspaceExpose,
} from '@app/types/workspaceExpose';
import { useWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { workspaceExposeRequiredMethodNames } from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import { cast } from '@tests/helpers/cast';

function createTab(overrides: Partial<ITab> = {}): ITab {
    return {
        id: 'tab-1',
        fileName: null,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
        ...overrides,
    };
}

function createWorkspace() {
    const workspace: Record<string, unknown> = {hasPdf: true};
    for (const method of workspaceExposeRequiredMethodNames) {
        workspace[method] = vi.fn();
    }
    return cast<IWorkspaceExpose>(workspace);
}

function createReadyRecord(fileName: string, originalPath: string, overrides: Partial<ITab> = {}) {
    return createWorkspaceDocumentRecord({
        tab: {
            fileName,
            originalPath,
            isDirty: overrides.isDirty ?? false,
            isDjvu: overrides.isDjvu ?? false,
        },
        toolbarSnapshot: {
            hasPdf: true,
            viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
                sidebar: true,
            },
            currentPage: 1,
            totalPages: 3,
        },
    });
}

describe('useWorkspaceDocumentSessions', () => {
    it('seeds pending document records without inventing a scroll-mode preference', () => {
        const sessions = useWorkspaceDocumentSessions({
            activeTabId: ref('tab-1'),
            tabs: ref([createTab({
                fileName: 'Paper.pdf',
                originalPath: '/tmp/Paper.pdf',
            })]),
        });

        expect(sessions.activeDocumentRecord.value?.tab).toMatchObject({
            fileName: 'Paper.pdf',
            originalPath: '/tmp/Paper.pdf',
        });
        expect(sessions.documentRecordsByTabId.value['tab-1']?.toolbarSnapshot).toMatchObject({
            hasPdf: true,
            isOpeningDocument: true,
        });
        expect(sessions.viewStateByTabId.value['tab-1']?.continuousScroll).toBe(false);
    });

    it('projects workspace refs from attached session workspaces', async () => {
        const tabs = ref([createTab()]);
        const sessions = useWorkspaceDocumentSessions({
            activeTabId: ref('tab-1'),
            tabs,
        });
        const workspace = createWorkspace();

        sessions.setWorkspaceRef('tab-1', workspace);

        expect(sessions.activeWorkspace.value).toBe(workspace);
        expect(sessions.workspaceRefs.value.get('tab-1')).toBe(workspace);
        await expect(sessions.waitForWorkspace('tab-1')).resolves.toBe(workspace);
    });

    it('applies workspace records as the authoritative projection', () => {
        const sessions = useWorkspaceDocumentSessions({
            activeTabId: ref('tab-1'),
            tabs: ref([createTab()]),
        });

        sessions.setWorkspaceDocumentRecord('tab-1', createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Ready.pdf',
                originalPath: '/tmp/Ready.pdf',
                isDirty: true,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                currentPage: 4,
                totalPages: 8,
            },
        }));

        expect(sessions.getDocumentRecord('tab-1')).toMatchObject({
            tab: {
                fileName: 'Ready.pdf',
                originalPath: '/tmp/Ready.pdf',
                isDirty: true,
            },
            toolbarSnapshot: {
                currentPage: 4,
                totalPages: 8,
            },
        });
    });

    it('removes sessions when tabs are removed', async () => {
        const tabs = ref([createTab()]);
        const sessions = useWorkspaceDocumentSessions({
            activeTabId: ref('tab-1'),
            tabs,
        });

        expect(sessions.getSession('tab-1')).not.toBeNull();

        tabs.value = [];
        await nextTick();

        expect(sessions.getSession('tab-1')).toBeNull();
        expect(sessions.documentRecordsByTabId.value).toEqual({});
    });

    it('does not recursively update when session projections are re-applied during a second open', async () => {
        const activeTabId = ref('tab-1');
        const tabs = ref([createTab()]);
        const sessions = useWorkspaceDocumentSessions({
            activeTabId,
            tabs,
        });
        let reapplyRuns = 0;
        let projectionRuns = 0;
        const stop = watch(
            () => sessions.documentRecordsByTabId.value,
            (recordsByTabId) => {
                projectionRuns += 1;
                for (const [
                    tabId,
                    record,
                ] of Object.entries(recordsByTabId)) {
                    reapplyRuns += 1;
                    if (reapplyRuns > 20) {
                        throw new Error('session projection feedback loop');
                    }

                    sessions.setWorkspaceDocumentRecord(tabId, record);
                    const sessionRecord = sessions.getDocumentRecord(tabId) ?? record;
                    sessions.applyViewState(tabId, sessionRecord.viewState);
                }
            },
            { flush: 'sync' },
        );

        try {
            sessions.setWorkspaceDocumentRecord('tab-1', createReadyRecord('First.pdf', '/docs/first.pdf'));
            await nextTick();

            sessions.setWorkspaceDocumentRecord('tab-1', createReadyRecord('First.pdf', '/docs/first.pdf', {isDirty: true}));
            await nextTick();

            const secondTab = createTab({
                id: 'tab-2',
                fileName: 'Second.pdf',
                originalPath: '/docs/second.pdf',
            });
            tabs.value = [
                tabs.value[0]!,
                secondTab,
            ];
            activeTabId.value = 'tab-2';
            await nextTick();

            sessions.setWorkspaceDocumentRecord('tab-2', createReadyRecord('Second.pdf', '/docs/second.pdf'));
            await nextTick();

            expect(reapplyRuns).toBeLessThanOrEqual(10);
            expect(projectionRuns).toBeLessThanOrEqual(5);
            expect(sessions.getDocumentRecord('tab-1')?.tab.isDirty).toBe(true);
            expect(sessions.getDocumentRecord('tab-2')?.tab.originalPath).toBe('/docs/second.pdf');
        } finally {
            stop();
        }
    });
});
