import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowState } from '@app/utils/pdf-viewer/annotations/annotationNoteWindowTypes';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import type { TDocumentRef } from '@contracts/documentRef';

interface ICreateDocumentAgentResourcesOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationDirty: Ref<boolean>;
    canSave: Ref<boolean>;
    createAgentBookmarkSnapshot: () => {
        bookmarks: unknown;
        count: number;
        dirty: boolean;
    };
    createAgentPageLabelSnapshot: () => object;
    currentPage: Ref<number>;
    hasPdf: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    normalizeAgentAnnotationComment: (comment: IAnnotationCommentSummary) => Record<string, unknown>;
    originalPath: Ref<TDocumentRef | null>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    tabId: string;
    totalPages: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

function parseAgentResourceUri(uri: string) {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error(`Invalid EVB resource URI: ${uri}`);
    }
    if (parsed.protocol !== 'evb:') {
        throw new Error(`Unsupported EVB resource URI protocol: ${parsed.protocol}`);
    }
    const parts = parsed.pathname
        .split('/')
        .filter(Boolean)
        .map(part => decodeURIComponent(part));
    return {
        host: parsed.hostname,
        parts,
    };
}

export function createDocumentAgentResources(options: ICreateDocumentAgentResourcesOptions) {
    const {
        annotationComments,
        annotationCommentsStatus,
        annotationDirty,
        canSave,
        createAgentBookmarkSnapshot,
        createAgentPageLabelSnapshot,
        currentPage,
        hasPdf,
        isAnySaving,
        normalizeAgentAnnotationComment,
        originalPath,
        sortedAnnotationNoteWindows,
        tabId,
        totalPages,
        workingCopyPath,
    } = options;

    function createAgentResource(uri: string): Record<string, unknown> {
        const parsed = parseAgentResourceUri(uri);
        if (parsed.host !== 'document') {
            throw new Error(`Unsupported workspace resource host: ${parsed.host}`);
        }
        const [
            resourceTabId,
            resourceKind,
        ] = parsed.parts;
        if (resourceTabId && resourceTabId !== tabId) {
            throw new Error(`Resource tab ${resourceTabId} does not match workspace tab ${tabId}.`);
        }

        if (!resourceKind || resourceKind === 'status' || resourceKind === 'state') {
            return {
                uri,
                tabId,
                status: 'ready',
                currentPage: currentPage.value,
                totalPages: totalPages.value,
                canSave: canSave.value,
                isSaving: isAnySaving.value,
                hasPdf: hasPdf.value,
                workingCopyPath: workingCopyPath.value,
                originalPath: originalPath.value,
                annotationDirty: annotationDirty.value,
                annotationNoteWindowsCount: sortedAnnotationNoteWindows.value.length,
                annotationCommentsStatus: annotationCommentsStatus.value,
                annotationCommentsCount: annotationComments.value.length,
            };
        }

        if (resourceKind === 'annotations') {
            return {
                uri,
                tabId,
                status: annotationCommentsStatus.value,
                count: annotationComments.value.length,
                annotations: annotationComments.value.map(normalizeAgentAnnotationComment),
            };
        }

        if (resourceKind === 'notes') {
            const openNoteByStableKey = new Map(
                sortedAnnotationNoteWindows.value.map(note => [
                    note.comment.stableKey,
                    note,
                ] as const),
            );
            const notes = annotationComments.value
                .filter(comment => (
                    comment.hasNote === true
                    || comment.text.trim().length > 0
                    || openNoteByStableKey.has(comment.stableKey)
                ))
                .map((comment) => {
                    const openNote = openNoteByStableKey.get(comment.stableKey) ?? null;
                    const openNoteMarkerRect = normalizeMarkerRect(openNote?.comment.markerRect);
                    const normalizedComment = normalizeAgentAnnotationComment(comment);
                    return {
                        ...normalizedComment,
                        markerRect: openNoteMarkerRect ?? normalizedComment.markerRect,
                        text: openNote?.text ?? comment.text,
                        isOpen: openNote !== null,
                        isMinimized: openNote?.isMinimized ?? false,
                        saving: openNote?.saving ?? false,
                        error: openNote?.error ?? null,
                        saveMode: openNote?.saveMode ?? null,
                    };
                });
            return {
                uri,
                tabId,
                status: annotationCommentsStatus.value,
                count: notes.length,
                notes,
            };
        }

        if (resourceKind === 'toc' || resourceKind === 'bookmarks') {
            const snapshot = createAgentBookmarkSnapshot();
            return {
                uri,
                tabId,
                status: 'ready',
                count: snapshot.count,
                dirty: snapshot.dirty,
                toc: snapshot.bookmarks,
                bookmarks: snapshot.bookmarks,
            };
        }

        if (resourceKind === 'page-labels' || resourceKind === 'page-numbering') {
            return {
                uri,
                tabId,
                status: 'ready',
                ...createAgentPageLabelSnapshot(),
            };
        }

        throw new Error(`Unsupported workspace document resource: ${resourceKind}`);
    }

    function readAgentResource(uri: string): Promise<Record<string, unknown>> {
        return Promise.resolve(createAgentResource(uri));
    }

    return { readAgentResource };
}
