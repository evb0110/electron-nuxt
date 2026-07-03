import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/public';
import * as pdfAnnotationRefs from '@app/utils/pdfAnnotationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';

type TPageAnnotationDeleteViewer = Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'deleteAnnotationComment'
    | 'removeAnnotationFromDom'
    | 'removeAnnotationFromInternalCache'
    | 'suppressAnnotationId'
    | 'suppressAnnotationStableKey'
> & Partial<Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'queuePendingEmbeddedAnnotationDelete'
    | 'registerAnnotationHistoryCommand'
    | 'restoreAnnotationToInternalCache'
    | 'unqueuePendingEmbeddedAnnotationDelete'
    | 'unsuppressAnnotationId'
    | 'unsuppressAnnotationStableKey'
>>;

interface IPageAnnotationDeleteActionsOptions<TViewer extends TPageAnnotationDeleteViewer = TPageAnnotationDeleteViewer> {
    pdfViewerRef: Ref<TViewer | null>;
    closeAnnotationContextMenu: () => void;
    getAnnotationCommentsSnapshot: () => IAnnotationCommentSummary[] | null;
    getDeleteErrorMessage: () => string;
    invalidateAnnotationPage: (comment: IAnnotationCommentSummary) => void;
    rerenderRestoredAnnotationPage: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromCache: (stableKey: string) => void;
    removeDeletedAnnotationState: (
        comment: IAnnotationCommentSummary,
        commentsBeforeDelete?: IAnnotationCommentSummary[] | null,
    ) => void;
    restoreAnnotationToCache: (comment: IAnnotationCommentSummary) => void;
    queuePendingEmbeddedAnnotationDelete: (comment: IAnnotationCommentSummary) => void;
    unqueuePendingEmbeddedAnnotationDelete: (stableKey: string) => void;
    setAnnotationNoteWindowError: (stableKey: string, error: string | null) => void;
    isNativeFreeTextNoteSaved?: ((comment: IAnnotationCommentSummary) => boolean) | undefined;
}

export const createPageAnnotationDeleteActions = <TViewer extends TPageAnnotationDeleteViewer>(
    options: IPageAnnotationDeleteActionsOptions<TViewer>,
) => {
    const {
        pdfViewerRef,
        closeAnnotationContextMenu,
        getAnnotationCommentsSnapshot,
        getDeleteErrorMessage,
        invalidateAnnotationPage,
        rerenderRestoredAnnotationPage,
        removeAnnotationFromCache,
        removeDeletedAnnotationState,
        restoreAnnotationToCache,
        queuePendingEmbeddedAnnotationDelete,
        unqueuePendingEmbeddedAnnotationDelete,
        setAnnotationNoteWindowError,
        isNativeFreeTextNoteSaved,
    } = options;

    let annotationDeleteQueue: Promise<void> = Promise.resolve();
    const pendingAnnotationDeleteStableKeys = new Set<string>();

    function resolveEmbeddedPdfAnnotationId(comment: IAnnotationCommentSummary) {
        const annotationId = pdfAnnotationRefs.normalizePdfJsAnnotationId(comment.annotationId);
        if (pdfAnnotationRefs.parsePdfJsAnnotationRef(annotationId)) {
            return annotationId;
        }

        const stableRef = comment.stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu)?.[1];
        const stableAnnotationId = pdfAnnotationRefs.normalizePdfJsAnnotationId(stableRef);
        if (pdfAnnotationRefs.parsePdfJsAnnotationRef(stableAnnotationId)) {
            return stableAnnotationId;
        }

        return null;
    }

    function shouldUseEmbeddedDeletePath(comment: IAnnotationCommentSummary) {
        return comment.source !== 'shape'
            && (comment.source === 'pdf' || Boolean(resolveEmbeddedPdfAnnotationId(comment)));
    }

    function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
        const subtype = comment.subtype?.trim().toLowerCase();
        return comment.source === 'editor'
            && !pdfAnnotationRefs.parsePdfJsAnnotationRef(comment.annotationId)
            && Boolean(comment.hasNote)
            && Boolean(normalizeMarkerRect(comment.markerRect))
            && (subtype === 'freetext' || subtype === 'typewriter');
    }

    function shouldQueueNativeSavedFreeTextDelete(comment: IAnnotationCommentSummary) {
        return isReplayableEditorOnlyFreeTextNote(comment)
            && isNativeFreeTextNoteSaved?.(comment) === true;
    }

    function shouldUseEmbeddedDeleteFallback(comment: IAnnotationCommentSummary, deleted: boolean) {
        return !deleted && shouldUseEmbeddedDeletePath(comment);
    }

    function queueDeferredEmbeddedDelete(comment: IAnnotationCommentSummary) {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return false;
        }
        const embeddedAnnotationId = resolveEmbeddedPdfAnnotationId(comment);
        const deletionComment: IAnnotationCommentSummary = embeddedAnnotationId && embeddedAnnotationId !== comment.annotationId
            ? {
                ...comment,
                annotationId: embeddedAnnotationId,
            }
            : comment;

        const applyDelete = () => {
            viewer.suppressAnnotationStableKey(comment.stableKey);
            if (viewer.queuePendingEmbeddedAnnotationDelete?.(deletionComment) !== true) {
                queuePendingEmbeddedAnnotationDelete(deletionComment);
            }
            if (embeddedAnnotationId) {
                viewer.suppressAnnotationId(embeddedAnnotationId);
            }
            viewer.removeAnnotationFromDom(deletionComment);
            viewer.removeAnnotationFromInternalCache(comment.stableKey);
            removeAnnotationFromCache(comment.stableKey);
            invalidateAnnotationPage(comment);
        };
        const undoDelete = () => {
            if (viewer.unqueuePendingEmbeddedAnnotationDelete) {
                viewer.unqueuePendingEmbeddedAnnotationDelete(comment.stableKey);
            } else {
                unqueuePendingEmbeddedAnnotationDelete(comment.stableKey);
            }
            viewer.unsuppressAnnotationStableKey?.(comment.stableKey);
            if (embeddedAnnotationId) {
                viewer.unsuppressAnnotationId?.(embeddedAnnotationId);
            }
            viewer.restoreAnnotationToInternalCache?.(comment);
            restoreAnnotationToCache(comment);
            rerenderRestoredAnnotationPage(comment);
        };

        // Keep embedded annotation deletes local until the user saves.
        // This matches note text edits and avoids an immediate rewrite/reload.
        applyDelete();
        viewer.registerAnnotationHistoryCommand?.({
            cmd: applyDelete,
            undo: undoDelete,
        });
        return true;
    }

    function handleAnnotationDeleteFailure(comment: IAnnotationCommentSummary) {
        BrowserLogger.warn('annotations', 'Delete annotation comment failed after all fallbacks', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            uid: comment.uid ?? null,
            id: comment.id,
        });
        setAnnotationNoteWindowError(comment.stableKey, getDeleteErrorMessage());
    }

    function deleteAnnotationCommentWithFallbacks(comment: IAnnotationCommentSummary, deleted: boolean) {
        if (!shouldUseEmbeddedDeleteFallback(comment, deleted)) {
            return deleted;
        }
        return queueDeferredEmbeddedDelete(comment);
    }

    async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }
        BrowserLogger.debug('annotations', 'Delete annotation comment requested', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            uid: comment.uid ?? null,
            pageNumber: comment.pageNumber,
        });
        setAnnotationNoteWindowError(comment.stableKey, null);
        const commentsBeforeDelete = getAnnotationCommentsSnapshot();
        if (shouldUseEmbeddedDeletePath(comment)) {
            const deleted = deleteAnnotationCommentWithFallbacks(comment, false);
            if (!deleted) {
                handleAnnotationDeleteFailure(comment);
                return;
            }
            removeDeletedAnnotationState(comment, commentsBeforeDelete);
            return;
        }

        const shouldQueueNativeFreeTextDelete = shouldQueueNativeSavedFreeTextDelete(comment);
        const viewerDeleted = await viewer.deleteAnnotationComment(comment);
        BrowserLogger.debug('annotations', 'Delete annotation comment viewer result', {
            stableKey: comment.stableKey,
            deleted: viewerDeleted,
            shouldQueueNativeFreeTextDelete,
        });

        const queuedNativeFreeTextDelete = shouldQueueNativeFreeTextDelete
            ? queueDeferredEmbeddedDelete(comment)
            : false;
        const deleted = shouldQueueNativeFreeTextDelete
            ? viewerDeleted || queuedNativeFreeTextDelete
            : deleteAnnotationCommentWithFallbacks(comment, viewerDeleted);
        if (!deleted) {
            handleAnnotationDeleteFailure(comment);
            return;
        }
        removeDeletedAnnotationState(comment, commentsBeforeDelete);
        invalidateAnnotationPage(comment);
    }

    async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        if (pendingAnnotationDeleteStableKeys.has(comment.stableKey)) {
            return;
        }
        pendingAnnotationDeleteStableKeys.add(comment.stableKey);
        annotationDeleteQueue = annotationDeleteQueue
            .catch(() => undefined)
            .then(async () => {
                try {
                    await performDeleteAnnotationComment(comment);
                } finally {
                    pendingAnnotationDeleteStableKeys.delete(comment.stableKey);
                }
            });
        await annotationDeleteQueue;
    }

    return { handleDeleteAnnotationComment };
};
