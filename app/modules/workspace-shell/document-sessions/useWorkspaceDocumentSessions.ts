import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/expose/isWorkspaceExpose';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import {
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
    createWorkspaceDocumentRecordFromTab,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { createWorkspaceDocumentSessionCore } from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';

interface IUseWorkspaceDocumentSessionsOptions {
    activeTabId: Ref<string | null>;
    tabs: Ref<ITab[]>;
}

interface IUseWorkspaceDocumentSessionsResult {
    activeDocumentRecord: ComputedRef<IWorkspaceDocumentRecord | null>;
    activeDocumentSession: ComputedRef<IWorkspaceDocumentSessionController | null>;
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>;
    documentRecordsByTabId: ComputedRef<Record<string, IWorkspaceDocumentRecord>>;
    documentSessionsByTabId: ComputedRef<Record<string, IWorkspaceDocumentSessionController>>;
    viewStateByTabId: ComputedRef<Record<string, ITabViewSessionState>>;
    workspaceRefs: ComputedRef<Map<string, IWorkspaceExpose>>;
    applyRevisionInfo: (tabId: string, info: IDocumentRevisionInfo | null) => void;
    applyViewState: (tabId: string, state: ITabViewSessionState) => void;
    getDocumentRecord: (tabId: string | null | undefined) => IWorkspaceDocumentRecord | null;
    getSession: (tabId: string | null | undefined) => IWorkspaceDocumentSessionController | null;
    removeDocumentRecord: (tabId: string) => void;
    seedTabDocumentRecord: (tabId: string, updates: TTabUpdate) => void;
    setWorkspaceDocumentRecord: (tabId: string, record: IWorkspaceDocumentRecord, source?: 'host' | 'workspace') => void;
    setWorkspaceRef: (tabId: string, el: unknown) => void;
    validateCommandTarget: (target: TWorkspaceCommandTarget) => {ok: true} | {
        ok: false;
        reason: string
    };
    waitForWorkspace: (tabId: string, timeoutMs?: number) => Promise<IWorkspaceExpose | null>;
}

function createSeedRecordForTab(tab: ITab): IWorkspaceDocumentRecord {
    return tabHasDocumentHint(tab)
        ? createPendingWorkspaceDocumentRecord(tab)
        : createWorkspaceDocumentRecordFromTab(tab);
}

export const useWorkspaceDocumentSessions = (
    options: IUseWorkspaceDocumentSessionsOptions,
): IUseWorkspaceDocumentSessionsResult => {
    const sessionsByTabId = shallowRef(new Map<string, IWorkspaceDocumentSessionController>());

    function getTabById(tabId: string | null | undefined) {
        return tabId ? options.tabs.value.find(tab => tab.id === tabId) ?? null : null;
    }

    function ensureSessionForTab(tab: ITab) {
        const existing = sessionsByTabId.value.get(tab.id);
        if (existing) {
            return existing;
        }

        const session = createWorkspaceDocumentSessionCore({
            tabId: tab.id,
            initialRecord: createSeedRecordForTab(tab),
        });
        sessionsByTabId.value.set(tab.id, session);
        triggerRef(sessionsByTabId);
        return session;
    }

    function getSession(tabId: string | null | undefined) {
        const tab = getTabById(tabId);
        if (!tab) {
            return null;
        }

        return ensureSessionForTab(tab);
    }

    function removeDocumentRecord(tabId: string) {
        const session = sessionsByTabId.value.get(tabId);
        session?.detachWorkspace();
        if (!sessionsByTabId.value.delete(tabId)) {
            return;
        }
        triggerRef(sessionsByTabId);
    }

    function getDocumentRecord(tabId: string | null | undefined) {
        return getSession(tabId)?.toDocumentRecord() ?? null;
    }

    function setWorkspaceDocumentRecord(
        tabId: string,
        record: IWorkspaceDocumentRecord,
        source: 'host' | 'workspace' = 'workspace',
    ) {
        const session = getSession(tabId);
        session?.applyWorkspaceRecord(record, source);
    }

    function seedTabDocumentRecord(tabId: string, updates: TTabUpdate) {
        const tab = getTabById(tabId);
        const current = getDocumentRecord(tabId);
        const nextTab = {
            fileName: updates.fileName ?? current?.tab.fileName ?? tab?.fileName ?? null,
            originalPath: updates.originalPath ?? current?.tab.originalPath ?? tab?.originalPath ?? null,
            isDirty: updates.isDirty ?? current?.tab.isDirty ?? tab?.isDirty ?? false,
            isDjvu: updates.isDjvu ?? current?.tab.isDjvu ?? tab?.isDjvu ?? false,
        };
        const isPendingDocumentHint = tabHasDocumentHint(nextTab)
            && current?.toolbarSnapshot.hasPdf !== true
            && !hasWorkspaceViewerDocumentCapabilities(current?.toolbarSnapshot.viewerCapabilities);
        const record = isPendingDocumentHint
            ? createPendingWorkspaceDocumentRecord(nextTab)
            : createWorkspaceDocumentRecord({
                tab: nextTab,
                documentIdentity: current?.documentIdentity,
                toolbarSnapshot: current?.toolbarSnapshot,
                viewState: current?.viewState,
            });

        setWorkspaceDocumentRecord(tabId, record, 'host');
    }

    function applyViewState(tabId: string, state: ITabViewSessionState) {
        getSession(tabId)?.applyViewState(state);
    }

    function applyRevisionInfo(tabId: string, info: IDocumentRevisionInfo | null) {
        getSession(tabId)?.applyRevisionInfo(info);
    }

    function setWorkspaceRef(tabId: string, el: unknown) {
        const session = getSession(tabId);
        if (!session) {
            return;
        }

        if (isWorkspaceExpose(el)) {
            session.attachWorkspace(el);
            return;
        }

        if (el) {
            BrowserLogger.warn('tabs', 'Ignoring workspace ref with unexpected shape', {
                tabId,
                receivedType: typeof el,
            });
        }
        session.detachWorkspace();
    }

    async function waitForWorkspace(tabId: string, timeoutMs?: number) {
        const session = getSession(tabId);
        if (!session) {
            return null;
        }

        return session.waitForWorkspace(session.createCommandTarget(), timeoutMs);
    }

    function validateCommandTarget(target: TWorkspaceCommandTarget) {
        return getSession(target.tabId)?.validateCommandTarget(target)
            ?? {
                ok: false,
                reason: 'tab-missing',
            };
    }

    watch(
        options.tabs,
        (tabs) => {
            const liveTabIds = new Set(tabs.map(tab => tab.id));
            for (const tab of tabs) {
                ensureSessionForTab(tab);
            }

            for (const tabId of [...sessionsByTabId.value.keys()]) {
                if (!liveTabIds.has(tabId)) {
                    removeDocumentRecord(tabId);
                }
            }
        },
        { immediate: true },
    );

    const documentSessionsByTabId = computed(() => Object.fromEntries(sessionsByTabId.value));
    const documentRecordsByTabId = computed(() => Object.fromEntries(
        [...sessionsByTabId.value].map(([
            tabId,
            session,
        ]) => [
            tabId,
            session.toDocumentRecord(),
        ]),
    ));
    const viewStateByTabId = computed(() => Object.fromEntries(
        [...sessionsByTabId.value].map(([
            tabId,
            session,
        ]) => [
            tabId,
            session.snapshot.value.viewState,
        ]),
    ));
    const workspaceRefs = computed(() => new Map(
        [...sessionsByTabId.value]
            .flatMap(([
                tabId,
                session,
            ]) => {
                const workspace = session.mountedWorkspace.value;
                return workspace
                    ? [[
                        tabId,
                        workspace,
                    ] as const]
                    : [];
            }),
    ));
    const activeDocumentSession = computed(() => getSession(options.activeTabId.value));
    const activeDocumentRecord = computed(() => activeDocumentSession.value?.toDocumentRecord() ?? null);
    const activeWorkspace = computed(() => activeDocumentSession.value?.mountedWorkspace.value ?? null);

    return {
        activeDocumentRecord,
        activeDocumentSession,
        activeWorkspace,
        applyRevisionInfo,
        applyViewState,
        documentRecordsByTabId,
        documentSessionsByTabId,
        getDocumentRecord,
        getSession,
        removeDocumentRecord,
        seedTabDocumentRecord,
        setWorkspaceDocumentRecord,
        setWorkspaceRef,
        validateCommandTarget,
        viewStateByTabId,
        waitForWorkspace,
        workspaceRefs,
    };
};
