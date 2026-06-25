import type { Ref } from 'vue';
import {
    syncRef,
    useStorage,
} from '@vueuse/core';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import {
    collectLivePdfJsAnnotationChangeFingerprint,
    resetLivePdfJsAnnotationStorageModifiedState,
} from '@app/modules/pdf-viewer/public';
import { useAnnotationContextMenu } from '@app/modules/workspace-shell/composables/useAnnotationContextMenu';
import { useAnnotationNoteWindows } from '@app/modules/workspace-shell/composables/useAnnotationNoteWindows';
import { BrowserLogger } from '@app/utils/browserLogger';
import { usePageAnnotationTools } from '@app/modules/workspace-shell/composables/usePageAnnotationTools';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { hasAnnotationChanges as detectAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasAnnotationChanges';
import { hasLivePdfJsAnnotationChanges as detectLivePdfJsAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasLivePdfJsAnnotationChanges';
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

    const savedAnnotationStorageFingerprint = ref<string | null>(null);
    const savedAnnotationStorageFingerprintPreservesLiveSession = ref(false);

    function captureAnnotationStorageFingerprint() {
        return collectLivePdfJsAnnotationChangeFingerprint(pdfDocument.value);
    }

    function clearAnnotationChanges() {
        try {
            resetLivePdfJsAnnotationStorageModifiedState(pdfDocument.value);
        } catch (error) {
            BrowserLogger.debug('workspace', 'Failed to reset annotation storage modified state', error);
        }
    }

    function hasAnnotationChanges() {
        return detectAnnotationChanges({
            pdfViewerRef,
            pdfDocument,
            savedAnnotationStorageFingerprint,
        });
    }

    function hasLivePdfJsAnnotationChanges() {
        return detectLivePdfJsAnnotationChanges({
            pdfDocument,
            savedAnnotationStorageFingerprint,
        });
    }

    function hasSavedPdfJsAnnotationBaselineChanges() {
        return savedAnnotationStorageFingerprintPreservesLiveSession.value
            && savedAnnotationStorageFingerprint.value !== null
            && hasLivePdfJsAnnotationChanges();
    }

    function hasPreservedLivePdfjsAnnotationSession() {
        return savedAnnotationStorageFingerprintPreservesLiveSession.value
            && savedAnnotationStorageFingerprint.value !== null;
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
        markAnnotationSaved: markAnnotationRevisionSaved,
        getAnnotationRevision,
        resetAnnotationTracking: resetAnnotationRevisionTracking,
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

    function markAnnotationSaved(opts?: { preserveLivePdfjsSession?: boolean }) {
        savedAnnotationStorageFingerprint.value = captureAnnotationStorageFingerprint();
        savedAnnotationStorageFingerprintPreservesLiveSession.value = opts?.preserveLivePdfjsSession === true;
        markAnnotationRevisionSaved();
    }

    function getAnnotationSaveStateToken() {
        return JSON.stringify({
            revision: getAnnotationRevision(),
            storage: captureAnnotationStorageFingerprint(),
        });
    }

    function resetAnnotationTracking() {
        savedAnnotationStorageFingerprint.value = null;
        savedAnnotationStorageFingerprintPreservesLiveSession.value = false;
        resetAnnotationRevisionTracking();
    }

    const annotationKeepActiveStorage = useStorage<string>(
        STORAGE_KEYS.ANNOTATION_KEEP_ACTIVE,
        '1',
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
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedLivePdfjsAnnotationSession,
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
        getAnnotationSaveStateToken,
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
