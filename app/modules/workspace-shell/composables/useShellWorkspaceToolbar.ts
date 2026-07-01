import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { workspaceHasPdf } from '@app/modules/workspace-shell/state/workspaceHasPdf';
import { shellToolbarHandoffWarningDelayMs } from '@app/modules/workspace-shell/toolbar/shellToolbarHandoffWarningDelayMs';
import { createDefaultWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { IWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';

interface IUseShellWorkspaceToolbarOptions {
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    hasTeleportedToolbarContent: Ref<boolean>;
    isTabTransitionBusy: Ref<boolean>;
    shellState: IWorkspaceShellState;
}

export const useShellWorkspaceToolbar = (options: IUseShellWorkspaceToolbarOptions) => {
    const showShellToolbar = computed(() => !options.hasTeleportedToolbarContent.value);
    const shellToolbarZoom = ref(1);
    const shellToolbarEffectiveZoom = ref(1);
    const shellToolbarZoomMode = ref<TZoomMode>('fit-width');
    const shellToolbarFitMode = ref<TFitMode>('width');
    const shellToolbarViewMode = ref<TPdfViewMode>('single');
    const shellToolbarCurrentPage = ref(1);
    const shellToolbarTotalPages = ref(0);
    const shellToolbarCanSave = ref(false);
    const shellToolbarCanRepairSave = ref(false);
    const shellToolbarCanOptimizePdf = ref(false);
    const shellToolbarCanUndo = ref(false);
    const shellToolbarCanRedo = ref(false);
    const shellToolbarCanExportDocx = ref(false);
    const shellToolbarIsSaving = ref(false);
    const shellToolbarIsSavingAs = ref(false);
    const shellToolbarIsAnySaving = ref(false);
    const shellToolbarIsHistoryBusy = ref(false);
    const shellToolbarIsExportingDocx = ref(false);
    const shellToolbarIsOpeningDocument = ref(false);
    const shellToolbarHasOpenError = ref(false);
    const shellToolbarIsPreparingPrint = ref(false);
    const shellToolbarIsPreparingCurrentPagePrint = ref(false);
    const shellToolbarIsFitWidthActive = ref(false);
    const shellToolbarIsFitHeightActive = ref(false);
    const shellToolbarShowSidebar = ref(false);
    const shellToolbarDragMode = ref(false);
    const shellToolbarContinuousScroll = ref(false);
    const shellToolbarIsDjvuMode = ref(false);
    const shellToolbarIsCapturingRegion = ref(false);
    const shellToolbarIsCropSelecting = ref(false);
    const shellToolbarIsPlacingPageNote = ref(false);
    const shellToolbarOcrPopupOpen = ref(false);
    const shellToolbarZoomDropdownOpen = ref(false);
    const shellToolbarPageDropdownOpen = ref(false);
    const shellToolbarOverflowMenuOpen = ref(false);
    const shellToolbarAppMenuOpen = ref(false);
    let missingToolbarWarningTimer: ReturnType<typeof setTimeout> | null = null;
    let warnedMissingToolbarForKey: string | null = null;

    function normalizeShellToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot): IWorkspaceToolbarSnapshot {
        const normalizedHasPdf = snapshot.hasPdf;
        let normalizedCurrentPage = 1;
        let normalizedTotalPages = 0;

        if (!snapshot.isOpeningDocument && normalizedHasPdf) {
            normalizedCurrentPage = Math.max(1, Math.floor(snapshot.currentPage));
            normalizedTotalPages = Math.max(normalizedCurrentPage, Math.floor(snapshot.totalPages));
        }

        const normalizedZoom = snapshot.isOpeningDocument ? 1 : snapshot.zoom;
        const normalizedEffectiveZoom = snapshot.isOpeningDocument ? 1 : snapshot.effectiveZoom;

        return {
            ...snapshot,
            zoom: normalizedZoom,
            effectiveZoom: normalizedEffectiveZoom,
            currentPage: normalizedCurrentPage,
            totalPages: normalizedTotalPages,
        };
    }

    function applyShellToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot | null | undefined) {
        if (!snapshot) {
            return;
        }

        const normalizedSnapshot = normalizeShellToolbarSnapshot(snapshot);

        shellToolbarCanSave.value = normalizedSnapshot.canSave;
        shellToolbarCanRepairSave.value = normalizedSnapshot.canRepairSave;
        shellToolbarCanOptimizePdf.value = normalizedSnapshot.canOptimizePdf;
        shellToolbarCanUndo.value = normalizedSnapshot.canUndo;
        shellToolbarCanRedo.value = normalizedSnapshot.canRedo;
        shellToolbarCanExportDocx.value = normalizedSnapshot.canExportDocx;
        shellToolbarIsSaving.value = normalizedSnapshot.isSaving;
        shellToolbarIsSavingAs.value = normalizedSnapshot.isSavingAs;
        shellToolbarIsAnySaving.value = normalizedSnapshot.isAnySaving;
        shellToolbarIsHistoryBusy.value = normalizedSnapshot.isHistoryBusy;
        shellToolbarIsExportingDocx.value = normalizedSnapshot.isExportingDocx;
        shellToolbarIsOpeningDocument.value = normalizedSnapshot.isOpeningDocument;
        shellToolbarHasOpenError.value = normalizedSnapshot.hasOpenError;
        shellToolbarIsPreparingPrint.value = normalizedSnapshot.isPreparingPrint;
        shellToolbarIsPreparingCurrentPagePrint.value = normalizedSnapshot.isPreparingCurrentPagePrint;
        shellToolbarIsFitWidthActive.value = normalizedSnapshot.isFitWidthActive;
        shellToolbarIsFitHeightActive.value = normalizedSnapshot.isFitHeightActive;
        shellToolbarShowSidebar.value = normalizedSnapshot.showSidebar;
        shellToolbarDragMode.value = normalizedSnapshot.dragMode;
        shellToolbarContinuousScroll.value = normalizedSnapshot.continuousScroll;
        shellToolbarIsDjvuMode.value = normalizedSnapshot.isDjvuMode;
        shellToolbarIsCapturingRegion.value = normalizedSnapshot.isCapturingRegion;
        shellToolbarIsCropSelecting.value = normalizedSnapshot.isCropSelecting;
        shellToolbarIsPlacingPageNote.value = normalizedSnapshot.isPlacingPageNote;
        shellToolbarZoom.value = normalizedSnapshot.zoom;
        shellToolbarEffectiveZoom.value = normalizedSnapshot.effectiveZoom;
        shellToolbarZoomMode.value = normalizedSnapshot.zoomMode;
        shellToolbarFitMode.value = normalizedSnapshot.fitMode;
        shellToolbarViewMode.value = normalizedSnapshot.viewMode;
        shellToolbarCurrentPage.value = normalizedSnapshot.currentPage;
        shellToolbarTotalPages.value = normalizedSnapshot.totalPages;
    }

    function readToolbarSnapshot(workspace: IWorkspaceExpose | null) {
        if (!workspace) {
            return null;
        }

        try {
            return workspace.getToolbarSnapshot();
        } catch (error) {
            BrowserLogger.debug('toolbar-transition', 'Failed to read toolbar snapshot', {
                activeTabId: options.activeTabId.value,
                activePaneId: options.activePaneId.value,
                error,
            });
            return null;
        }
    }

    function primeShellToolbarFromWorkspace(workspace: IWorkspaceExpose | null) {
        applyShellToolbarSnapshot(readToolbarSnapshot(workspace));
    }

    const shellToolbarHasPdf = computed(() => {
        return options.shellState.hasDocument.value;
    });

    const shellToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => {
        const liveSnapshot = readToolbarSnapshot(options.activeWorkspace.value);
        if (liveSnapshot) {
            return normalizeShellToolbarSnapshot({
                ...liveSnapshot,
                hasPdf: liveSnapshot.hasPdf || shellToolbarHasPdf.value,
            });
        }

        return {
            hasPdf: shellToolbarHasPdf.value,
            isOpeningDocument: shellToolbarIsOpeningDocument.value,
            hasOpenError: shellToolbarHasOpenError.value,
            isPreparingPrint: shellToolbarIsPreparingPrint.value,
            isPreparingCurrentPagePrint: shellToolbarIsPreparingCurrentPagePrint.value,
            canSave: shellToolbarCanSave.value,
            canRepairSave: shellToolbarCanRepairSave.value,
            canOptimizePdf: shellToolbarCanOptimizePdf.value,
            canUndo: shellToolbarCanUndo.value,
            canRedo: shellToolbarCanRedo.value,
            canExportDocx: shellToolbarCanExportDocx.value,
            isSaving: shellToolbarIsSaving.value,
            isSavingAs: shellToolbarIsSavingAs.value,
            isAnySaving: shellToolbarIsAnySaving.value,
            isHistoryBusy: shellToolbarIsHistoryBusy.value,
            isExportingDocx: shellToolbarIsExportingDocx.value,
            isFitWidthActive: shellToolbarIsFitWidthActive.value,
            isFitHeightActive: shellToolbarIsFitHeightActive.value,
            showSidebar: shellToolbarShowSidebar.value,
            dragMode: shellToolbarDragMode.value,
            continuousScroll: shellToolbarContinuousScroll.value,
            isDjvuMode: shellToolbarIsDjvuMode.value,
            isCapturingRegion: shellToolbarIsCapturingRegion.value,
            isCropSelecting: shellToolbarIsCropSelecting.value,
            isPlacingPageNote: shellToolbarIsPlacingPageNote.value,
            zoom: shellToolbarZoom.value,
            effectiveZoom: shellToolbarEffectiveZoom.value,
            zoomMode: shellToolbarZoomMode.value,
            fitMode: shellToolbarFitMode.value,
            viewMode: shellToolbarViewMode.value,
            currentPage: shellToolbarCurrentPage.value,
            totalPages: shellToolbarTotalPages.value,
        };
    });

    function getMissingToolbarWarningKey() {
        return `${options.activePaneId.value ?? 'no-pane'}:${options.activeTabId.value ?? 'no-tab'}`;
    }

    function clearMissingToolbarWarningTimer() {
        if (!missingToolbarWarningTimer) {
            return;
        }
        clearTimeout(missingToolbarWarningTimer);
        missingToolbarWarningTimer = null;
    }

    function shouldWarnAboutMissingTeleportedToolbarContent() {
        if (!showShellToolbar.value || options.isTabTransitionBusy.value || options.activeWorkspace.value === null) {
            return false;
        }

        const snapshot = shellToolbarSnapshot.value;
        return (
            (snapshot.hasPdf || snapshot.isDjvuMode)
            && !snapshot.isOpeningDocument
            && !snapshot.hasOpenError
        );
    }

    function scheduleMissingToolbarWarningIfNeeded() {
        const warningKey = getMissingToolbarWarningKey();
        if (!shouldWarnAboutMissingTeleportedToolbarContent()) {
            clearMissingToolbarWarningTimer();
            warnedMissingToolbarForKey = null;
            return;
        }

        if (warnedMissingToolbarForKey === warningKey || missingToolbarWarningTimer) {
            return;
        }

        missingToolbarWarningTimer = setTimeout(() => {
            missingToolbarWarningTimer = null;
            if (!shouldWarnAboutMissingTeleportedToolbarContent()) {
                return;
            }

            warnedMissingToolbarForKey = warningKey;
            BrowserLogger.diagnostic('toolbar-transition', 'Shell toolbar handoff stayed visible without teleported workspace toolbar content', {
                activeTabId: options.activeTabId.value,
                activePaneId: options.activePaneId.value,
                isTabTransitionBusy: options.isTabTransitionBusy.value,
                hasTeleportedToolbarContent: options.hasTeleportedToolbarContent.value,
            });
        }, shellToolbarHandoffWarningDelayMs);
    }

    applyShellToolbarSnapshot(createDefaultWorkspaceToolbarSnapshot());

    watch(options.activeWorkspace, (workspace) => {
        primeShellToolbarFromWorkspace(workspace);
    }, { immediate: true });

    watch(
        [
            options.activeTabId,
            options.activeWorkspace,
        ],
        () => {
            if (options.isTabTransitionBusy.value || !options.hasTeleportedToolbarContent.value) {
                return;
            }

            if (workspaceHasPdf(options.activeWorkspace.value)) {
                return;
            }
            if (options.shellState.activeTabHasDocumentHint.value) {
                return;
            }

            applyShellToolbarSnapshot(createDefaultWorkspaceToolbarSnapshot());
        },
        { immediate: true },
    );

    watch(
        [
            showShellToolbar,
            options.isTabTransitionBusy,
            options.activeWorkspace,
            options.activePaneId,
            options.activeTabId,
            shellToolbarSnapshot,
        ],
        scheduleMissingToolbarWarningIfNeeded,
        { immediate: true },
    );

    tryOnScopeDispose(clearMissingToolbarWarningTimer);

    return {
        applyShellToolbarSnapshot,
        handleShellToolbarOverflowSetViewMode(mode: TPdfViewMode, runAction: (action: (workspace: IWorkspaceExpose) => void) => void) {
            shellToolbarViewMode.value = mode;
            runAction((workspace) => {
                if (mode === 'single') {
                    workspace.handleViewModeSingle();
                    return;
                }
                if (mode === 'facing') {
                    workspace.handleViewModeFacing();
                    return;
                }
                workspace.handleViewModeFacingFirstSingle();
            });
        },
        primeShellToolbarFromWorkspace,
        shellToolbarAppMenuOpen,
        shellToolbarCurrentPage,
        shellToolbarEffectiveZoom,
        shellToolbarFitMode,
        shellToolbarHasPdf,
        shellToolbarOcrPopupOpen,
        shellToolbarOverflowMenuOpen,
        shellToolbarPageDropdownOpen,
        shellToolbarSnapshot,
        shellToolbarViewMode,
        shellToolbarZoom,
        shellToolbarZoomMode,
        shellToolbarZoomDropdownOpen,
        showShellToolbar,
    };
};
