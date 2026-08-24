import type { TAnnotationCreationFailureReason } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';

/**
 * One place where workspace operations that failed become visible.
 *
 * Before issue #91 each site invented its own reporting, so several failure
 * paths reported nothing at all. Callers hand this surface a typed reason; it
 * owns the localized copy and the toast.
 *
 * Only saves keep durable state. A failed save outlives its toast because the
 * status bar has to keep presenting the document as unwritten; a rejected
 * annotation leaves nothing behind to present, so it is told once and dropped
 * rather than parked in a container nothing reads.
 */
type TWorkspaceFailureDomain = 'save' | 'annotation';

export type TWorkspaceSaveFailureReason =
    | 'validation-rejected'
    | 'note-persistence-failed'
    | 'capability-unavailable'
    | 'persist-rejected'
    | 'document-changed'
    | 'unexpected-error';

export const useWorkspaceFailureSurface = () => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const hasSaveFailureState = ref(false);
    // Only the operation reported last per domain, so a long session of failed
    // attempts cannot accumulate ids nothing will ever read again.
    const lastReportedOperationIds = new Map<TWorkspaceFailureDomain, string>();

    /**
     * Shows the toast unless this operation already produced one. A low-level
     * failure and the service result that follows it share one operation id,
     * so the user sees one toast for one failed action.
     */
    function toastOnce(failure: {
        domain: TWorkspaceFailureDomain;
        operationId: string;
        title: string;
        description: string | null;
    }) {
        if (lastReportedOperationIds.get(failure.domain) === failure.operationId) {
            BrowserLogger.debug('workspace', 'Suppressed duplicate workspace failure toast', {
                domain: failure.domain,
                operationId: failure.operationId,
            });
            return false;
        }
        lastReportedOperationIds.set(failure.domain, failure.operationId);
        toast.add({
            color: 'error',
            title: failure.title,
            ...(failure.description ? {description: failure.description} : {}),
        });
        return true;
    }

    function clearSaveFailure() {
        lastReportedOperationIds.delete('save');
        hasSaveFailureState.value = false;
    }

    function describeSaveFailure(reason: TWorkspaceSaveFailureReason) {
        switch (reason) {
            case 'validation-rejected':
                return t('errors.save.validation');
            case 'note-persistence-failed':
                return t('errors.save.openNotes');
            case 'document-changed':
                return t('errors.save.documentChanged');
            case 'capability-unavailable':
            case 'persist-rejected':
            case 'unexpected-error':
                return t('errors.save.notCompleted');
        }
    }

    function reportSaveFailure(
        operationId: string,
        reason: TWorkspaceSaveFailureReason,
        detail?: string | null,
    ) {
        // A save that lost its target says nothing about the document now on
        // screen, so it is told once and not kept.
        if (reason !== 'document-changed') {
            hasSaveFailureState.value = true;
        }
        return toastOnce({
            domain: 'save',
            operationId,
            title: t('errors.file.save'),
            description: detail ?? describeSaveFailure(reason),
        });
    }

    /**
     * Not every rejected creation deserves a toast. Markup shortcuts fire on
     * every pointer release, and an annotation whose editor is still resolving
     * is not a user problem, so those reasons stay silent. Returning `null`
     * marks a reason as silent; a returned object may still carry no extra
     * detail beyond the shared title.
     */
    function describeAnnotationFailure(
        reason: TAnnotationCreationFailureReason,
    ): {description: string | null} | null {
        switch (reason) {
            case 'selection-spans-pages':
                return {description: t('errors.annotation.selectionSpansPages')};
            case 'mode-switch-failed':
            case 'editor-binding-failed':
            case 'projection-failed':
            case 'point-outside-page':
            case 'page-not-rendered':
            case 'viewer-not-ready':
                return {description: null};
            case 'no-selection':
            case 'selection-not-in-text-layer':
            case 'editor-unavailable':
                return null;
        }
    }

    function reportAnnotationFailure(failure: {
        operationId: string;
        reason: TAnnotationCreationFailureReason;
    }) {
        const described = describeAnnotationFailure(failure.reason);
        if (!described) {
            BrowserLogger.debug('annotations', 'Annotation creation failure is not user-visible', failure);
            return false;
        }
        return toastOnce({
            domain: 'annotation',
            operationId: failure.operationId,
            title: t('errors.annotation.create'),
            description: described.description,
        });
    }

    return {
        hasSaveFailure: computed(() => hasSaveFailureState.value),
        clearSaveFailure,
        reportSaveFailure,
        reportAnnotationFailure,
    };
};

export type TWorkspaceFailureSurface = ReturnType<typeof useWorkspaceFailureSurface>;
