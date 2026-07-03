import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
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

describe('useWorkspaceDocumentSessions', () => {
    it('seeds document records and view state from tab hints', () => {
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
        expect(sessions.viewStateByTabId.value['tab-1']?.continuousScroll).toBe(true);
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
});
