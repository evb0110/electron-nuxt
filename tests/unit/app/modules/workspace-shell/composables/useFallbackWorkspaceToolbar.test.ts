import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useFallbackWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useFallbackWorkspaceToolbar';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspace-expose';
import type { ITab } from '@app/types/tabs';

function cast<T>(value: unknown): T {
    return value as T;
}

function createSnapshot(overrides: Partial<IWorkspaceToolbarSnapshot> = {}): IWorkspaceToolbarSnapshot {
    return {
        hasPdf: false,
        isOpeningDocument: false,
        isPreparingPrint: false,
        canSave: false,
        canUndo: false,
        canRedo: false,
        canExportDocx: false,
        isSaving: false,
        isSavingAs: false,
        isAnySaving: false,
        isHistoryBusy: false,
        isExportingDocx: false,
        isFitWidthActive: false,
        isFitHeightActive: false,
        showSidebar: false,
        dragMode: false,
        continuousScroll: false,
        isDjvuMode: false,
        isCapturingRegion: false,
        isCropSelecting: false,
        isPlacingPageNote: false,
        zoom: 1,
        effectiveZoom: 1,
        zoomMode: 'fit-width',
        fitMode: 'width',
        viewMode: 'single',
        currentPage: 1,
        totalPages: 0,
        ...overrides,
    };
}

function createWorkspace(snapshot: IWorkspaceToolbarSnapshot): IWorkspaceExpose {
    return cast<IWorkspaceExpose>({
        hasPdf: { value: snapshot.hasPdf },
        getToolbarSnapshot: () => snapshot,
    });
}

function createPlaceholderTab(tabId: string): ITab {
    return {
        id: tabId,
        fileName: null,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
    };
}

describe('useFallbackWorkspaceToolbar', () => {
    it('preserves isOpeningDocument from the active workspace snapshot', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(createWorkspace(createSnapshot({ isOpeningDocument: true })));
        const toolbar = useFallbackWorkspaceToolbar({
            activeGroupId: ref('group-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace,
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            getTabById: (_tabId: string) => createPlaceholderTab('tab-1'),
        });

        expect(toolbar.fallbackToolbarSnapshot.value.isOpeningDocument).toBe(true);
    });

    it('defaults isOpeningDocument to false without an active workspace', () => {
        const toolbar = useFallbackWorkspaceToolbar({
            activeGroupId: ref('group-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace: ref<IWorkspaceExpose | null>(null),
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            getTabById: (_tabId: string) => createPlaceholderTab('tab-1'),
        });

        expect(toolbar.fallbackToolbarSnapshot.value.isOpeningDocument).toBe(false);
    });

    it('tracks live workspace snapshot changes while the fallback toolbar is visible', async () => {
        const snapshot = ref(createSnapshot({
            canSave: false,
            hasPdf: true,
        }));
        const activeWorkspace = ref<IWorkspaceExpose | null>(cast<IWorkspaceExpose>({
            hasPdf: { value: true },
            getToolbarSnapshot: () => snapshot.value,
        }));

        const toolbar = useFallbackWorkspaceToolbar({
            activeGroupId: ref('group-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace,
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            getTabById: (_tabId: string) => createPlaceholderTab('tab-1'),
        });

        expect(toolbar.fallbackToolbarSnapshot.value.canSave).toBe(false);

        snapshot.value = createSnapshot({
            canSave: true,
            hasPdf: true,
        });
        await nextTick();

        expect(toolbar.fallbackToolbarSnapshot.value.canSave).toBe(true);
    });
});
