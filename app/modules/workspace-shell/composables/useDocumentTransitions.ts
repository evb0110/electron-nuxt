import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    TAnnotationTool,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platformApi';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import { BrowserLogger } from '@app/utils/browserLogger';

export interface IDocumentTransitionDeps {
    pdfSrc: Ref<TPdfSource | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    pdfError: Ref<unknown>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    pdfDocument: Ref<unknown | null>;
    dragMode: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    annotationTool: Ref<TAnnotationTool>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationCommentsLoading: () => void;
    clearAnnotationComments: () => void;
    annotationActiveCommentStableKey: Ref<string | null>;
    annotationEditorState: Ref<IAnnotationEditorState>;
    annotationPlacingPageNote: Ref<boolean>;
    bookmarkItems: Ref<unknown[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkEditMode: Ref<boolean>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges: Ref<unknown[]>;
    pageLabelsDirty: Ref<boolean>;
    pdfViewerRef: Ref<{
        clearShapes: () => void;
        cancelCommentPlacement: () => void 
    } | null>;
    resetAnnotationTracking: () => void;
    resetSearchCache: () => void;
    closeSearch: () => void;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeAllAnnotationNotes: (opts?: { saveIfDirty?: boolean }) => Promise<boolean>;
    loadRecentFiles: () => void;
}

export const useDocumentTransitions = (deps: IDocumentTransitionDeps) => {
    const {
        pdfSrc,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        pdfError,
        currentPage,
        totalPages,
        pdfDocument,
        dragMode,
        showSidebar,
        sidebarTab,
        annotationTool,
        annotationComments,
        markAnnotationCommentsLoading,
        clearAnnotationComments,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationPlacingPageNote,
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pdfViewerRef,
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
    } = deps;

    watch(pdfError, (err) => {
        if (err) {
            BrowserLogger.error('pdf', 'PDF Error', err);
        }
    });

    watch(
        () => [
            showSidebar.value,
            sidebarTab.value,
        ] as const,
        ([
            isOpen,
            tab,
        ]) => {
            if (!isOpen || tab !== 'bookmarks') {
                bookmarkEditMode.value = false;
            }
        },
    );

    watch(dragMode, (enabled) => {
        if (enabled) {
            window.getSelection()?.removeAllRanges();
            if (annotationTool.value !== 'none') {
                annotationTool.value = 'none';
            }
            pdfViewerRef.value?.cancelCommentPlacement();
            annotationPlacingPageNote.value = false;
        }
    });

    watch(pdfSrc, (newSrc, oldSrc) => {
        if (newSrc && newSrc !== oldSrc) {
            const isReload = Boolean(oldSrc);
            currentPage.value = 1;
            resetAnnotationTracking();
            markAnnotationCommentsLoading();
            if (!isReload) {
                clearAnnotationComments();
            }
            bookmarkItems.value = [];
            bookmarksDirty.value = false;
            bookmarkEditMode.value = false;
            closeAnnotationContextMenu();
            closePageContextMenu();
        }
        if (!newSrc) {
            const previousDocument = pdfDocument.value as { destroy?: () => Promise<void> } | null;
            currentPage.value = 1;
            totalPages.value = 0;
            pdfDocument.value = null;
            if (previousDocument?.destroy) {
                previousDocument.destroy().catch((error) => {
                    BrowserLogger.debug(
                        'pdf-document',
                        'PDF document destroy rejected during close',
                        error,
                    );
                });
            }
            resetSearchCache();
            closeSearch();
            annotationTool.value = 'none';
            clearAnnotationComments();
            annotationActiveCommentStableKey.value = null;
            pageLabels.value = null;
            pageLabelRanges.value = [];
            pageLabelsDirty.value = false;
            bookmarkItems.value = [];
            bookmarksDirty.value = false;
            bookmarkEditMode.value = false;
            pdfViewerRef.value?.clearShapes();
            closeAnnotationContextMenu();
            closePageContextMenu();
            void closeAllAnnotationNotes({ saveIfDirty: false });
            resetAnnotationTracking();
            annotationEditorState.value = {
                isEditing: false,
                isEmpty: true,
                hasSomethingToUndo: false,
                hasSomethingToRedo: false,
                hasSelectedEditor: false,
            };
        }

    });

    watch(workingCopyPath, (nextPath, previousPath) => {
        if (nextPath === previousPath) {
            return;
        }

        if (nextPath) {
            loadRecentFiles();
        }

        annotationActiveCommentStableKey.value = null;
        closeAnnotationContextMenu();
        void closeAllAnnotationNotes({ saveIfDirty: false });
    });

    watch(
        () => [
            isDjvuMode.value,
            djvuSourcePath.value,
        ] as const,
        (
            [
                nextIsDjvuMode,
                nextDjvuSourcePath,
            ],
            [
                previousIsDjvuMode,
                previousDjvuSourcePath,
            ],
        ) => {
            if (
                nextIsDjvuMode
                && nextDjvuSourcePath
                && (
                    nextDjvuSourcePath !== previousDjvuSourcePath
                    || nextIsDjvuMode !== previousIsDjvuMode
                )
            ) {
                loadRecentFiles();
            }
        },
    );

    watch(annotationComments, (comments) => {
        if (
            annotationActiveCommentStableKey.value
            && !comments.some(comment => comment.stableKey === annotationActiveCommentStableKey.value)
        ) {
            annotationActiveCommentStableKey.value = null;
        }
    });
};
