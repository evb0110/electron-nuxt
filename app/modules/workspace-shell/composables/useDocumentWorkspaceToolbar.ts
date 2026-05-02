import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import { BrowserLogger } from '@app/utils/browser-logger';
import { useAnalytics } from '@app/composables/useAnalytics';
import type { ICropMargins } from '@app/types/crop';
import type { TPdfViewMode } from '@contracts/shared';

interface IUseDocumentWorkspaceToolbarOptions {
    tabId: string;
    emitOpenSettings: () => void;
    closeAllDropdowns: () => void;
    handleSave: () => unknown;
    handleSaveAs: () => unknown;
    handleExportDocx: () => unknown;
    handleUndo: () => unknown;
    handleRedo: () => unknown;
    handleCaptureRegion: () => unknown;
    handleCrop: () => unknown;
    handleQuickNoteAction: () => unknown;
    handleFitMode: (mode: 'width' | 'height') => void;
    handleAnnotationToolChange: (tool: 'none') => void;
    enableDragMode: () => void;
    handleRemoveCrop: (pages: number[]) => unknown;
    handleCropPages: (pages: number[], margins: ICropMargins) => unknown;
    workingCopyPath: Ref<TDocumentRef | null | undefined>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<unknown>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    isLoading: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<unknown>;
    viewMode: Ref<TPdfViewMode>;
    zoom: Ref<number>;
    pdfViewerRef: Ref<{ getViewerContainer?: () => HTMLElement | null; } | null>;
    isResizingSidebar: Ref<boolean>;
}

export const useDocumentWorkspaceToolbar = (options: IUseDocumentWorkspaceToolbarOptions) => {
    const analytics = useAnalytics();
    const sidebarToggleCheckpointTimers = new Set<ReturnType<typeof setTimeout>>();

    const canExportDocx = computed(() => (
        Boolean(options.workingCopyPath.value)
        && !options.isAnySaving.value
        && !options.isHistoryBusy.value
        && !options.isExportingDocx.value
    ));

    function clearSidebarToggleCheckpointTimers() {
        for (const timer of sidebarToggleCheckpointTimers) {
            clearTimeout(timer);
        }
        sidebarToggleCheckpointTimers.clear();
    }

    function runToolbarAction(action: () => unknown) {
        const result = action();
        if (result instanceof Promise) {
            void result.catch((error: unknown) => {
                BrowserLogger.error('workspace', 'Toolbar action failed', {
                    tabId: options.tabId,
                    error,
                });
            });
        }
        options.closeAllDropdowns();
    }

    function handleToolbarToggleSidebar() {
        clearSidebarToggleCheckpointTimers();
        const attemptId = `sidebar-toggle-${crypto.randomUUID()}`;
        const beforePage = options.currentPage.value;
        const beforeSidebar = options.showSidebar.value;
        const viewer = options.pdfViewerRef.value?.getViewerContainer?.() ?? null;
        const beforeViewerScrollTop = viewer ? Math.round(viewer.scrollTop) : null;
        BrowserLogger.warn('pdf-nav', 'Toolbar sidebar toggle requested', {
            attemptId,
            beforeSidebar,
            beforePage,
            sidebarTab: options.sidebarTab.value,
            totalPages: options.totalPages.value,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            viewerScrollTop: beforeViewerScrollTop,
        });
        runToolbarAction(() => {
            options.showSidebar.value = !options.showSidebar.value;
            BrowserLogger.warn('pdf-nav', 'Toolbar sidebar toggle applied', {
                attemptId,
                afterSidebar: options.showSidebar.value,
                pageAfterToggleWrite: options.currentPage.value,
            });
        });
        analytics.track('viewer_mode_changed', {
            control: 'sidebar',
            previousValue: beforeSidebar,
            nextValue: !beforeSidebar,
        });

        const checkpointSchedule = [
            0,
            50,
            150,
            350,
            700,
            1200,
        ];
        checkpointSchedule.forEach((delayMs) => {
            const timer = setTimeout(() => {
                sidebarToggleCheckpointTimers.delete(timer);
                const checkpointViewer = options.pdfViewerRef.value?.getViewerContainer?.() ?? null;
                BrowserLogger.warn(
                    'pdf-nav',
                    `[sidebar-toggle-checkpoint] attempt=${attemptId} t+${delayMs}ms page=${options.currentPage.value} sidebar=${options.showSidebar.value}`,
                    {
                        attemptId,
                        delayMs,
                        page: options.currentPage.value,
                        sidebarOpen: options.showSidebar.value,
                        sidebarTab: options.sidebarTab.value,
                        isResizingSidebar: options.isResizingSidebar.value,
                        fitMode: options.fitMode.value,
                        viewMode: options.viewMode.value,
                        continuousScroll: options.continuousScroll.value,
                        zoom: options.zoom.value,
                        viewerScrollTop: checkpointViewer ? Math.round(checkpointViewer.scrollTop) : null,
                        viewerScrollLeft: checkpointViewer ? Math.round(checkpointViewer.scrollLeft) : null,
                        viewerClientHeight: checkpointViewer ? Math.round(checkpointViewer.clientHeight) : null,
                    },
                );
            }, delayMs);
            sidebarToggleCheckpointTimers.add(timer);
        });
    }

    return {
        canExportDocx,
        clearSidebarToggleCheckpointTimers,
        handleCropApply(payload: {
            margins: ICropMargins;
            pages: number[];
        }) {
            void options.handleCropPages(payload.pages, payload.margins);
        },
        handleCropRemove(payload: { pages: number[]; }) {
            void options.handleRemoveCrop(payload.pages);
        },
        handleOverflowOpenSettings() {
            runToolbarAction(() => {
                options.emitOpenSettings();
            });
        },
        handleOverflowSetViewMode(mode: TPdfViewMode) {
            const previousValue = options.viewMode.value;
            runToolbarAction(() => {
                options.viewMode.value = mode;
            });
            if (previousValue !== mode) {
                analytics.track('viewer_mode_changed', {
                    control: 'view_mode',
                    previousValue,
                    nextValue: mode,
                });
            }
        },
        handleToolbarCaptureRegion() {
            runToolbarAction(options.handleCaptureRegion);
        },
        handleToolbarCrop() {
            runToolbarAction(options.handleCrop);
        },
        handleToolbarDisableDrag() {
            runToolbarAction(() => {
                options.handleAnnotationToolChange('none');
            });
            analytics.track('viewer_mode_changed', {
                control: 'drag_mode',
                previousValue: true,
                nextValue: false,
            });
        },
        handleToolbarEnableDrag() {
            runToolbarAction(() => {
                options.enableDragMode();
            });
            analytics.track('viewer_mode_changed', {
                control: 'drag_mode',
                previousValue: false,
                nextValue: true,
            });
        },
        handleToolbarExportDocx() {
            runToolbarAction(options.handleExportDocx);
        },
        handleToolbarFitHeight() {
            const previousValue = options.fitMode.value;
            runToolbarAction(() => {
                options.handleFitMode('height');
            });
            analytics.track('viewer_mode_changed', {
                control: 'fit_mode',
                previousValue: String(previousValue),
                nextValue: 'height',
            });
        },
        handleToolbarFitWidth() {
            const previousValue = options.fitMode.value;
            runToolbarAction(() => {
                options.handleFitMode('width');
            });
            analytics.track('viewer_mode_changed', {
                control: 'fit_mode',
                previousValue: String(previousValue),
                nextValue: 'width',
            });
        },
        handleToolbarQuickNote() {
            runToolbarAction(options.handleQuickNoteAction);
        },
        handleToolbarRedo() {
            runToolbarAction(options.handleRedo);
        },
        handleToolbarSave() {
            runToolbarAction(options.handleSave);
        },
        handleToolbarSaveAs() {
            runToolbarAction(options.handleSaveAs);
        },
        handleToolbarToggleContinuousScroll() {
            const previousValue = options.continuousScroll.value;
            runToolbarAction(() => {
                options.continuousScroll.value = !options.continuousScroll.value;
            });
            analytics.track('viewer_mode_changed', {
                control: 'continuous_scroll',
                previousValue,
                nextValue: !previousValue,
            });
        },
        handleToolbarToggleSidebar,
        handleToolbarUndo() {
            runToolbarAction(options.handleUndo);
        },
    };
};
