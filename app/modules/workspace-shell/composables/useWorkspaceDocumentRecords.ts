import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import {
    areWorkspaceDocumentRecordsEqual,
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
    createWorkspaceDocumentRecordFromTab,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { hasWorkspaceViewerDocumentCapabilities } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

interface IUseWorkspaceDocumentRecordsOptions {
    activeTabId: Ref<string | null>;
    tabs: Ref<ITab[]>;
}

interface IUseWorkspaceDocumentRecordsResult {
    activeDocumentRecord: ComputedRef<IWorkspaceDocumentRecord | null>;
    documentRecordsByTabId: ComputedRef<Record<string, IWorkspaceDocumentRecord>>;
    getDocumentRecord: (tabId: string | null | undefined) => IWorkspaceDocumentRecord | null;
    removeDocumentRecord: (tabId: string) => void;
    seedTabDocumentRecord: (tabId: string, updates: TTabUpdate) => void;
    setWorkspaceDocumentRecord: (tabId: string, record: IWorkspaceDocumentRecord) => void;
}

export const useWorkspaceDocumentRecords = (
    options: IUseWorkspaceDocumentRecordsOptions,
): IUseWorkspaceDocumentRecordsResult => {
    const recordsByTabId = shallowRef<Record<string, IWorkspaceDocumentRecord>>({});

    function getTabById(tabId: string | null | undefined): ITab | null {
        return tabId ? options.tabs.value.find(tab => tab.id === tabId) ?? null : null;
    }

    function publishRecord(tabId: string, record: IWorkspaceDocumentRecord): void {
        if (areWorkspaceDocumentRecordsEqual(recordsByTabId.value[tabId], record)) {
            return;
        }
        recordsByTabId.value = {
            ...recordsByTabId.value,
            [tabId]: record,
        };
    }

    function removeDocumentRecord(tabId: string): void {
        if (!(tabId in recordsByTabId.value)) {
            return;
        }
        const {
            [tabId]: _removed,
            ...nextRecords
        } = recordsByTabId.value;
        recordsByTabId.value = nextRecords;
    }

    function getDocumentRecord(tabId: string | null | undefined): IWorkspaceDocumentRecord | null {
        if (!tabId) {
            return null;
        }
        const tab = getTabById(tabId);
        return recordsByTabId.value[tabId] ?? (
            tab
                ? createSeedRecordForTab(tab)
                : null
        );
    }

    function createSeedRecordForTab(tab: ITab): IWorkspaceDocumentRecord {
        return tabHasDocumentHint(tab)
            ? createPendingWorkspaceDocumentRecord(tab)
            : createWorkspaceDocumentRecordFromTab(tab);
    }

    function setWorkspaceDocumentRecord(tabId: string, record: IWorkspaceDocumentRecord): void {
        publishRecord(tabId, createWorkspaceDocumentRecord(record));
    }

    function seedTabDocumentRecord(tabId: string, updates: TTabUpdate): void {
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
        publishRecord(
            tabId,
            isPendingDocumentHint
                ? createPendingWorkspaceDocumentRecord(nextTab)
                : createWorkspaceDocumentRecord({
                    tab: nextTab,
                    toolbarSnapshot: current?.toolbarSnapshot,
                    viewState: current?.viewState,
                }),
        );
    }

    watch(
        options.tabs,
        (tabs: ITab[]) => {
            const liveTabIds = new Set(tabs.map(tab => tab.id));
            const nextRecords: Record<string, IWorkspaceDocumentRecord> = {};
            for (const tab of tabs) {
                nextRecords[tab.id] = recordsByTabId.value[tab.id] ?? createSeedRecordForTab(tab);
            }
            for (const tabId of Object.keys(recordsByTabId.value)) {
                if (!liveTabIds.has(tabId)) {
                    continue;
                }
                nextRecords[tabId] = recordsByTabId.value[tabId]!;
            }
            recordsByTabId.value = nextRecords;
        },
        { immediate: true },
    );

    const activeDocumentRecord: ComputedRef<IWorkspaceDocumentRecord | null> = computed(() => getDocumentRecord(options.activeTabId.value));
    const documentRecordsByTabId: ComputedRef<Record<string, IWorkspaceDocumentRecord>> = computed(() => recordsByTabId.value);

    return {
        activeDocumentRecord,
        documentRecordsByTabId,
        getDocumentRecord,
        removeDocumentRecord,
        seedTabDocumentRecord,
        setWorkspaceDocumentRecord,
    };
};
