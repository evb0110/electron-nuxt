import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';

export interface IPendingAnnotationMarkerMove {
    markerRect: IAnnotationMarkerRect;
    previousMarkerRect: IAnnotationMarkerRect | null;
    movedAt: number;
}

export interface IPdfAnnotationCommentModel {
    annotationCommentsCache: ShallowRef<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    pendingMarkerMoves: Map<string, IPendingAnnotationMarkerMove>;
    emitCommentsForSidebar: (
        comments: IAnnotationCommentSummary[],
        options?: { includeShapes?: boolean },
    ) => void;
    upsertComment(comment: IAnnotationCommentSummary): void;
    toTextMarkupSubtype(comment: IAnnotationCommentSummary): TMarkupSubtype | null;
    updateCachedColor(comment: IAnnotationCommentSummary, color: string): void;
    withTransientNoteCreationTimestamp(comment: IAnnotationCommentSummary): IAnnotationCommentSummary;
    markLocallyDeleted(comment: IAnnotationCommentSummary): void;
    restoreLocally(comment: IAnnotationCommentSummary): void;
    applyFromSync(comments: IAnnotationCommentSummary[]): IAnnotationCommentSummary[];
    isGracePreservedEditorOnlyComment(comment: IAnnotationCommentSummary): boolean;
    handleMarkerMove(
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        options?: {
            markEditorPending?: (
                updated: IAnnotationCommentSummary,
                original: IAnnotationCommentSummary,
                markerRect: IAnnotationMarkerRect,
            ) => void;
            markModified?: () => void;
        },
    ): boolean;
    getSnapshot(): IAnnotationCommentSummary[];
    removeFromInternalCache(stableKey: string): void;
    clearPendingMarkerMoves(): void;
    handleSourceChanged(next: unknown, previous: unknown, options?: { syncAnnotationComments?: () => void | Promise<void> }): void;
}
