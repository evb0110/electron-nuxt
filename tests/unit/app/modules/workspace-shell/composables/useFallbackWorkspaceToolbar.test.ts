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
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { ITab } from '@app/types/tabs';
import { cast } from '@tests/helpers/cast';

function createSnapshot(overrides: Partial<IWorkspaceToolbarSnapshot> = {}): IWorkspaceToolbarSnapshot {
    return {
        hasPdf: false,
        isOpeningDocument: false,
        hasOpenError: false,
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

function createShellState(activeWorkspace: ReturnType<typeof ref<IWorkspaceExpose | null>>, activeTabId = 'tab-1') {
    return useWorkspaceShellState({
        activeWorkspace,
        activeTabId: ref<string | null>(activeTabId),
        tabs: ref([createPlaceholderTab(activeTabId)]),
    });
}

describe('useFallbackWorkspaceToolbar', () => {
    it('preserves isOpeningDocument from the active workspace snapshot', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(createWorkspace(createSnapshot({ isOpeningDocument: true })));
        const toolbar = useFallbackWorkspaceToolbar({
            activePaneId: ref('pane-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace,
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            shellState: createShellState(activeWorkspace),
        });

        expect(toolbar.fallbackToolbarSnapshot.value.isOpeningDocument).toBe(true);
    });

    it('defaults isOpeningDocument to false without an active workspace', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(null);
        const toolbar = useFallbackWorkspaceToolbar({
            activePaneId: ref('pane-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace,
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            shellState: createShellState(activeWorkspace),
        });

        expect(toolbar.fallbackToolbarSnapshot.value.isOpeningDocument).toBe(false);
    });

    it('seeds the fallback snapshot with default values when no workspace is active', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(null);
        const toolbar = useFallbackWorkspaceToolbar({
            activePaneId: ref('pane-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace,
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            shellState: createShellState(activeWorkspace),
        });

        expect(toolbar.fallbackToolbarSnapshot.value).toEqual(createDefaultWorkspaceToolbarSnapshot());
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
            activePaneId: ref('pane-1'),
            activeTabId: ref('tab-1'),
            activeWorkspace,
            hasTeleportedToolbarContent: ref(false),
            isTabTransitionBusy: ref(false),
            shellState: createShellState(activeWorkspace),
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

describe('createDefaultWorkspaceToolbarSnapshot', () => {
    it('returns the documented default shape', () => {
        expect(createDefaultWorkspaceToolbarSnapshot()).toEqual({
            hasPdf: false,
            isOpeningDocument: false,
            hasOpenError: false,
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
        });
    });

    it('returns a fresh object each call without aliasing', () => {
        const first = createDefaultWorkspaceToolbarSnapshot();
        const second = createDefaultWorkspaceToolbarSnapshot();

        expect(first).not.toBe(second);

        first.hasPdf = true;
        first.zoom = 2;

        expect(second.hasPdf).toBe(false);
        expect(second.zoom).toBe(1);
    });
});
