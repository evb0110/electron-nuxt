import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useShellWorkspaceToolbar } from '@app/modules/workspace-shell/composables/useShellWorkspaceToolbar';
import { shellToolbarHandoffWarningDelayMs } from '@app/modules/workspace-shell/toolbar/shellToolbarHandoffWarningDelayMs';
import { useWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { ITab } from '@app/types/tabs';
import { cast } from '@tests/helpers/cast';

function createSnapshot(overrides: Partial<IWorkspaceToolbarSnapshot> = {}): IWorkspaceToolbarSnapshot {
    return {
        hasPdf: false,
        isOpeningDocument: false,
        hasOpenError: false,
        isPreparingPrint: false,
        isPreparingCurrentPagePrint: false,
        canSave: false,
        canRepairSave: false,
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

function createToolbarOptions(overrides: Partial<Parameters<typeof useShellWorkspaceToolbar>[0]> = {}) {
    const activeWorkspace = ref<IWorkspaceExpose | null>(null);
    return {
        activePaneId: ref('pane-1'),
        activeTabId: ref('tab-1'),
        activeWorkspace,
        hasTeleportedToolbarContent: ref(false),
        isTabTransitionBusy: ref(true),
        shellState: createShellState(activeWorkspace),
        ...overrides,
    };
}

describe('useShellWorkspaceToolbar', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('preserves isOpeningDocument from the active workspace snapshot', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(createWorkspace(createSnapshot({ isOpeningDocument: true })));
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({
            activeWorkspace,
            shellState: createShellState(activeWorkspace),
        }));

        expect(toolbar.shellToolbarSnapshot.value.isOpeningDocument).toBe(true);
    });

    it('defaults isOpeningDocument to false without an active workspace', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(null);
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({
            activeWorkspace,
            shellState: createShellState(activeWorkspace),
        }));

        expect(toolbar.shellToolbarSnapshot.value.isOpeningDocument).toBe(false);
    });

    it('seeds the shell handoff snapshot with default values when no workspace is active', () => {
        const activeWorkspace = ref<IWorkspaceExpose | null>(null);
        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({
            activeWorkspace,
            shellState: createShellState(activeWorkspace),
        }));

        expect(toolbar.shellToolbarSnapshot.value).toEqual(createDefaultWorkspaceToolbarSnapshot());
    });

    it('tracks live workspace snapshot changes while the shell toolbar is visible', async () => {
        const snapshot = ref(createSnapshot({
            canSave: false,
            hasPdf: true,
        }));
        const activeWorkspace = ref<IWorkspaceExpose | null>(cast<IWorkspaceExpose>({
            hasPdf: { value: true },
            getToolbarSnapshot: () => snapshot.value,
        }));

        const toolbar = useShellWorkspaceToolbar(createToolbarOptions({
            activeWorkspace,
            shellState: createShellState(activeWorkspace),
        }));

        expect(toolbar.shellToolbarSnapshot.value.canSave).toBe(false);

        snapshot.value = createSnapshot({
            canSave: true,
            hasPdf: true,
        });
        await nextTick();

        expect(toolbar.shellToolbarSnapshot.value.canSave).toBe(true);
    });

    it('keeps expected transition handoff quiet', async () => {
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const activeWorkspace = ref<IWorkspaceExpose | null>(createWorkspace(createSnapshot({
            hasPdf: true,
            totalPages: 3,
        })));
        useShellWorkspaceToolbar(createToolbarOptions({
            activeWorkspace,
            isTabTransitionBusy: ref(true),
            shellState: createShellState(activeWorkspace),
        }));

        await vi.advanceTimersByTimeAsync(shellToolbarHandoffWarningDelayMs + 1);

        expect(warn).not.toHaveBeenCalled();
    });

    it('warns when shell handoff remains visible after transition with a mounted document workspace', async () => {
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        const activeWorkspace = ref<IWorkspaceExpose | null>(createWorkspace(createSnapshot({
            hasPdf: true,
            totalPages: 3,
        })));
        useShellWorkspaceToolbar(createToolbarOptions({
            activeWorkspace,
            isTabTransitionBusy: ref(false),
            shellState: createShellState(activeWorkspace),
        }));

        await vi.advanceTimersByTimeAsync(shellToolbarHandoffWarningDelayMs - 1);
        expect(warn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        expect(warn).toHaveBeenCalledWith(
            'toolbar-transition',
            'Shell toolbar handoff stayed visible without teleported workspace toolbar content',
            expect.objectContaining({
                activeTabId: 'tab-1',
                activePaneId: 'pane-1',
                isTabTransitionBusy: false,
                hasTeleportedToolbarContent: false,
            }),
        );
    });
});

describe('createDefaultWorkspaceToolbarSnapshot', () => {
    it('returns the documented default shape', () => {
        expect(createDefaultWorkspaceToolbarSnapshot()).toEqual({
            hasPdf: false,
            isOpeningDocument: false,
            hasOpenError: false,
            isPreparingPrint: false,
            isPreparingCurrentPagePrint: false,
            canSave: false,
            canRepairSave: false,
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
