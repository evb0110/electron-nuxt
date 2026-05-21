import type { Ref } from 'vue';
import {
    syncRef,
    useStorage,
} from '@vueuse/core';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import { useAnnotationContextMenu } from '@app/composables/pdf/useAnnotationContextMenu';
import { useAnnotationNoteWindows } from '@app/composables/pdf/useAnnotationNoteWindows';
import { BrowserLogger } from '@app/utils/browserLogger';
import { usePageAnnotationTools } from '@app/modules/workspace-shell/composables/usePageAnnotationTools';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import { hasAnnotationChanges as detectAnnotationChanges } from '@app/modules/workspace-shell/composables/workspaceAnnotationUtils';
import type { PDFDocumentProxy } from '@app/types/pdf';

interface IWorkspaceAnnotationSessionOptions {
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    dragMode: Ref<boolean>;
}

export const useWorkspaceAnnotationSession = (options: IWorkspaceAnnotationSessionOptions) => {
    const {
        pdfViewerRef,
        pdfDocument,
        dragMode,
    } = options;

    const {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
    } = useAnnotationContextMenu();

    function clearAnnotationChanges() {
        try {
            pdfDocument.value?.annotationStorage?.resetModified();
        } catch (error) {
            BrowserLogger.debug('workspace', 'Failed to reset annotation storage modified state', error);
        }
    }

    function hasAnnotationChanges() {
        return detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument,
        });
    }

    const {
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        resetAnnotationTracking,
        markAnnotationCommentsLoading,
        applyAnnotationComments,
        clearAnnotationComments,
    } = usePageAnnotationTools({
        pdfViewerRef,
        dragMode,
        clearAnnotationChanges,
        closeAnnotationContextMenu,
        hasAnnotationChanges,
    });

    const annotationKeepActiveStorage = useStorage<string>(
        STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE,
        '0',
        undefined,
        { initOnMounted: true },
    );
    syncRef(annotationKeepActive, annotationKeepActiveStorage, {transform: {
        ltr: value => (value ? '1' : '0'),
        rtl: stored => stored === '1',
    }});

    const {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote: openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
    } = useAnnotationNoteWindows({
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer: (comment, text) => pdfViewerRef.value?.updateAnnotationComment(comment, text) ?? false,
        isAnnotationCommentSyncReady: () => Boolean(pdfDocument.value),
    });

    const hasOpenAnnotationNotes = ref(false);
    watch(() => annotationNoteWindows.value.length, (count) => {
        hasOpenAnnotationNotes.value = count > 0;
    }, { immediate: true });

    const hasPendingTabChanges = computed(() => (
        annotationDirty.value
        || hasAnnotationChanges()
    ));

    return {
        annotationContextMenu,
        annotationContextMenuStyle,
        annotationContextMenuCanCopy,
        annotationContextMenuCanCopySelection,
        annotationContextMenuCanCreateFree,
        annotationContextMenuCanInsertImage,
        annotationContextMenuIsImage,
        contextMenuAnnotationLabel,
        contextMenuDeleteActionLabel,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        clearAnnotationChanges,
        hasAnnotationChanges,
        hasPendingAnnotationChanges: hasPendingTabChanges,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationComments,
        annotationCommentsStatus,
        annotationActiveCommentStableKey,
        annotationEditorState,
        annotationDirty,
        handleAnnotationToolChange,
        handleAnnotationToolAutoReset,
        handleAnnotationToolCancel,
        handleAnnotationSettingChange,
        handleAnnotationState,
        handleAnnotationModified,
        markAnnotationDirty,
        markAnnotationSaved,
        resetAnnotationTracking,
        markAnnotationCommentsLoading,
        applyAnnotationComments,
        clearAnnotationComments,
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        hasOpenAnnotationNotes,
        isAnyAnnotationNoteSaving,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
    };
};
