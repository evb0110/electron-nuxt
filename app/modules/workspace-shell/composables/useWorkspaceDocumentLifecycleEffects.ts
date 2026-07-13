import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { useDocumentTransitions } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import type { IDocumentTransitionDeps } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import { useWorkspaceUiSyncWatchers } from '@app/modules/workspace-shell/composables/useWorkspaceUiSyncWatchers';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';

interface IWorkspaceDocumentLifecycleEffectsOptions extends IDocumentTransitionDeps {
    documentRevisionInfo: Ref<IDocumentRevisionInfo | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        clearShapes: () => void;
        cancelCommentPlacement: () => void;
    } | null>;
    showSettings: Ref<boolean>;
    emitOpenSettings: () => void;
}

export const useWorkspaceDocumentLifecycleEffects = (options: IWorkspaceDocumentLifecycleEffectsOptions) => {
    const {
        documentRevisionInfo,
        documentRevisionToken,
        currentPage,
        pdfViewerRef,
        showSettings,
        emitOpenSettings,
        pdfSrc,
        totalPages,
        pdfDocument,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        pdfError,
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
        resetAnnotationTracking,
        resetSearchCache,
        closeSearch,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeAllAnnotationNotes,
        loadRecentFiles,
        consumePreservedSourceReloadMetadata,
    } = options;

    const documentFiles = getDocumentFilesCapability();
    let revisionRefreshRequestId = 0;

    async function refreshDocumentRevision(path: TDocumentRef) {
        const requestId = ++revisionRefreshRequestId;
        try {
            const revision = await documentFiles.getDocumentRevision(path);
            if (
                requestId === revisionRefreshRequestId
                && workingCopyPath.value === path
            ) {
                documentRevisionInfo.value = revision;
                documentRevisionToken.value = revision.token;
            }
        } catch {
            if (
                requestId === revisionRefreshRequestId
                && workingCopyPath.value === path
            ) {
                documentRevisionInfo.value = null;
                documentRevisionToken.value = null;
            }
        }
    }

    watch(workingCopyPath, (path) => {
        revisionRefreshRequestId += 1;
        documentRevisionInfo.value = null;
        documentRevisionToken.value = null;
        if (path) {
            void refreshDocumentRevision(path);
        }
    }, {immediate: true});

    const unsubscribeDocumentRevision = documentFiles.onDocumentRevisionChanged?.((event) => {
        if (event.documentRef !== workingCopyPath.value) {
            return;
        }
        revisionRefreshRequestId += 1;
        documentRevisionInfo.value = event;
        documentRevisionToken.value = event.token;
    }) ?? null;

    tryOnScopeDispose(() => {
        unsubscribeDocumentRevision?.();
    });

    useWorkspaceUiSyncWatchers({
        showSettings,
        emitOpenSettings,
    });

    useDocumentTransitions({
        pdfSrc,
        currentPage,
        totalPages,
        pdfDocument,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        pdfError,
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
        consumePreservedSourceReloadMetadata,
    });
};
