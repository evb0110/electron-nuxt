import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { workspaceHasPdf } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { IWorkspaceShellState } from '@app/modules/workspace-shell/composables/useWorkspaceShellState';

interface IUseFallbackWorkspaceToolbarOptions {
    activeGroupId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    activeWorkspace: Ref<IWorkspaceExpose | null>;
    hasTeleportedToolbarContent: Ref<boolean>;
    isTabTransitionBusy: Ref<boolean>;
    shellState: IWorkspaceShellState;
}

export const useFallbackWorkspaceToolbar = (options: IUseFallbackWorkspaceToolbarOptions) => {
    const showFallbackToolbar = computed(() => !options.hasTeleportedToolbarContent.value);
    const fallbackZoom = ref(1);
    const fallbackEffectiveZoom = ref(1);
    const fallbackZoomMode = ref<TZoomMode>('fit-width');
    const fallbackFitMode = ref<TFitMode>('width');
    const fallbackViewMode = ref<TPdfViewMode>('single');
    const fallbackCurrentPage = ref(1);
    const fallbackTotalPages = ref(0);
    const fallbackCanSave = ref(false);
    const fallbackCanUndo = ref(false);
    const fallbackCanRedo = ref(false);
    const fallbackCanExportDocx = ref(false);
    const fallbackIsSaving = ref(false);
    const fallbackIsSavingAs = ref(false);
    const fallbackIsAnySaving = ref(false);
    const fallbackIsHistoryBusy = ref(false);
    const fallbackIsExportingDocx = ref(false);
    const fallbackIsOpeningDocument = ref(false);
    const fallbackHasOpenError = ref(false);
    const fallbackIsPreparingPrint = ref(false);
    const fallbackIsFitWidthActive = ref(false);
    const fallbackIsFitHeightActive = ref(false);
    const fallbackShowSidebar = ref(false);
    const fallbackDragMode = ref(false);
    const fallbackContinuousScroll = ref(false);
    const fallbackIsDjvuMode = ref(false);
    const fallbackIsCapturingRegion = ref(false);
    const fallbackIsCropSelecting = ref(false);
    const fallbackIsPlacingPageNote = ref(false);
    const fallbackOcrPopupOpen = ref(false);
    const fallbackZoomDropdownOpen = ref(false);
    const fallbackPageDropdownOpen = ref(false);
    const fallbackOverflowMenuOpen = ref(false);
    const fallbackAppMenuOpen = ref(false);

    function applyFallbackToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot | null | undefined) {
        if (!snapshot) {
            return;
        }

        const normalizedHasPdf = snapshot.hasPdf;
        const normalizedCurrentPage = normalizedHasPdf
            ? Math.max(1, Math.floor(snapshot.currentPage))
            : 1;
        const normalizedTotalPages = normalizedHasPdf
            ? Math.max(normalizedCurrentPage, Math.floor(snapshot.totalPages))
            : 0;

        fallbackCanSave.value = snapshot.canSave;
        fallbackCanUndo.value = snapshot.canUndo;
        fallbackCanRedo.value = snapshot.canRedo;
        fallbackCanExportDocx.value = snapshot.canExportDocx;
        fallbackIsSaving.value = snapshot.isSaving;
        fallbackIsSavingAs.value = snapshot.isSavingAs;
        fallbackIsAnySaving.value = snapshot.isAnySaving;
        fallbackIsHistoryBusy.value = snapshot.isHistoryBusy;
        fallbackIsExportingDocx.value = snapshot.isExportingDocx;
        fallbackIsOpeningDocument.value = snapshot.isOpeningDocument;
        fallbackHasOpenError.value = snapshot.hasOpenError;
        fallbackIsPreparingPrint.value = snapshot.isPreparingPrint;
        fallbackIsFitWidthActive.value = snapshot.isFitWidthActive;
        fallbackIsFitHeightActive.value = snapshot.isFitHeightActive;
        fallbackShowSidebar.value = snapshot.showSidebar;
        fallbackDragMode.value = snapshot.dragMode;
        fallbackContinuousScroll.value = snapshot.continuousScroll;
        fallbackIsDjvuMode.value = snapshot.isDjvuMode;
        fallbackIsCapturingRegion.value = snapshot.isCapturingRegion;
        fallbackIsCropSelecting.value = snapshot.isCropSelecting;
        fallbackIsPlacingPageNote.value = snapshot.isPlacingPageNote;
        fallbackZoom.value = snapshot.zoom;
        fallbackEffectiveZoom.value = snapshot.effectiveZoom;
        fallbackZoomMode.value = snapshot.zoomMode;
        fallbackFitMode.value = snapshot.fitMode;
        fallbackViewMode.value = snapshot.viewMode;
        fallbackCurrentPage.value = normalizedCurrentPage;
        fallbackTotalPages.value = normalizedTotalPages;
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
                activeGroupId: options.activeGroupId.value,
                error,
            });
            return null;
        }
    }

    function primeFallbackToolbarFromWorkspace(workspace: IWorkspaceExpose | null) {
        applyFallbackToolbarSnapshot(readToolbarSnapshot(workspace));
    }

    const fallbackHasPdf = computed(() => {
        return options.shellState.hasDocument.value;
    });

    const fallbackToolbarSnapshot = computed<IWorkspaceToolbarSnapshot>(() => {
        const liveSnapshot = readToolbarSnapshot(options.activeWorkspace.value);
        if (liveSnapshot) {
            return {
                ...liveSnapshot,
                hasPdf: liveSnapshot.hasPdf || fallbackHasPdf.value,
            };
        }

        return {
            hasPdf: fallbackHasPdf.value,
            isOpeningDocument: fallbackIsOpeningDocument.value,
            hasOpenError: fallbackHasOpenError.value,
            isPreparingPrint: fallbackIsPreparingPrint.value,
            canSave: fallbackCanSave.value,
            canUndo: fallbackCanUndo.value,
            canRedo: fallbackCanRedo.value,
            canExportDocx: fallbackCanExportDocx.value,
            isSaving: fallbackIsSaving.value,
            isSavingAs: fallbackIsSavingAs.value,
            isAnySaving: fallbackIsAnySaving.value,
            isHistoryBusy: fallbackIsHistoryBusy.value,
            isExportingDocx: fallbackIsExportingDocx.value,
            isFitWidthActive: fallbackIsFitWidthActive.value,
            isFitHeightActive: fallbackIsFitHeightActive.value,
            showSidebar: fallbackShowSidebar.value,
            dragMode: fallbackDragMode.value,
            continuousScroll: fallbackContinuousScroll.value,
            isDjvuMode: fallbackIsDjvuMode.value,
            isCapturingRegion: fallbackIsCapturingRegion.value,
            isCropSelecting: fallbackIsCropSelecting.value,
            isPlacingPageNote: fallbackIsPlacingPageNote.value,
            zoom: fallbackZoom.value,
            effectiveZoom: fallbackEffectiveZoom.value,
            zoomMode: fallbackZoomMode.value,
            fitMode: fallbackFitMode.value,
            viewMode: fallbackViewMode.value,
            currentPage: fallbackCurrentPage.value,
            totalPages: fallbackTotalPages.value,
        };
    });

    applyFallbackToolbarSnapshot(createDefaultWorkspaceToolbarSnapshot());

    watch(options.activeWorkspace, (workspace) => {
        primeFallbackToolbarFromWorkspace(workspace);
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

            applyFallbackToolbarSnapshot(createDefaultWorkspaceToolbarSnapshot());
        },
        { immediate: true },
    );

    return {
        applyFallbackToolbarSnapshot,
        fallbackAppMenuOpen,
        fallbackCurrentPage,
        fallbackEffectiveZoom,
        fallbackFitMode,
        fallbackHasPdf,
        fallbackOcrPopupOpen,
        fallbackOverflowMenuOpen,
        fallbackPageDropdownOpen,
        fallbackToolbarSnapshot,
        fallbackViewMode,
        fallbackZoom,
        fallbackZoomMode,
        fallbackZoomDropdownOpen,
        handleFallbackOverflowSetViewMode(mode: TPdfViewMode, runAction: (action: (workspace: IWorkspaceExpose) => void) => void) {
            fallbackViewMode.value = mode;
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
        primeFallbackToolbarFromWorkspace,
        showFallbackToolbar,
    };
};
