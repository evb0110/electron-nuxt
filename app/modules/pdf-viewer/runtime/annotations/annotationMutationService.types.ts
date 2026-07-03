import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { ITextMarkupColorMutationResult } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import type { IAnnotationMutationVisualEffectsState } from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';

export type TAnnotationMutationSource =
    | 'user'
    | 'note-window'
    | 'agent'
    | 'undo'
    | 'redo'
    | 'sync'
    | 'save-reload';

export interface IAnnotationMutationContext {
    source: TAnnotationMutationSource;
    scheduleSync?: boolean;
    history?: 'record' | 'skip' | 'replay';
}

export interface IAnnotationUpdateCommentInput {
    comment: IAnnotationCommentSummary;
    text: string;
}

export interface IAnnotationDeleteInput {
    comment: IAnnotationCommentSummary;
    strategy?: 'auto' | 'pdfjs' | 'embedded-deferred' | 'shape' | 'local-only';
}

export interface IAnnotationUpdateColorInput {
    comment?: IAnnotationCommentSummary | null;
    color: string;
    selected?: boolean;
}

export interface IAnnotationUpdateMetadataInput {
    comment: IAnnotationCommentSummary;
    patch: Record<string, unknown>;
}

export interface IAnnotationMoveMarkerInput {
    comment: IAnnotationCommentSummary;
    rect: IAnnotationMarkerRect;
}

export interface IAnnotationSuppressionTarget {
    annotationId?: string | null | undefined;
    stableKey?: string | null | undefined;
}

export interface IAnnotationPendingEmbeddedTextUpdateInput {
    comment: IAnnotationCommentSummary;
    text: string;
    stableKey?: string | null | undefined;
}

export interface IAnnotationPendingEmbeddedMutationSnapshot {
    pendingEmbeddedTextUpdates: Map<string, string>;
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
}

export interface IAnnotationMarkerMoveOptions {
    markEditorPending?: (
        updated: IAnnotationCommentSummary,
        original: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
    ) => void;
    markModified?: () => void;
}

export interface IConsumedAnnotationEmbeddedMutations {
    pendingEmbeddedTextUpdates: Map<string, string>;
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
    restore(): void;
    commit(): void;
}

export interface IAnnotationMutationService {
    pendingEmbeddedMutationVersion: Ref<number>;
    visualEffects: IAnnotationMutationVisualEffectsState;
    updateComment(input: IAnnotationUpdateCommentInput, context: IAnnotationMutationContext): boolean;
    deleteAnnotation(input: IAnnotationDeleteInput, context: IAnnotationMutationContext): Promise<boolean>;
    updateColor(input: IAnnotationUpdateColorInput, context: IAnnotationMutationContext): boolean;
    updateMetadata(input: IAnnotationUpdateMetadataInput, context: IAnnotationMutationContext): boolean;
    moveMarker(input: IAnnotationMoveMarkerInput, context: IAnnotationMutationContext): boolean;
    restoreAnnotation(comment: IAnnotationCommentSummary, context: IAnnotationMutationContext): void;
    enqueueAnnotationDomRemoval(comment: IAnnotationCommentSummary): void;
    removeAnnotationFromInternalCache(stableKey: string, context: IAnnotationMutationContext): void;
    clearPendingMarkerMoves(): void;
    suppressAnnotation(target: IAnnotationSuppressionTarget): void;
    unsuppressAnnotation(target: IAnnotationSuppressionTarget): void;
    queuePendingEmbeddedTextUpdate(input: IAnnotationPendingEmbeddedTextUpdateInput): boolean;
    clearPendingEmbeddedTextUpdate(stableKey: string): void;
    migratePendingEmbeddedTextUpdate(previousKey: string, nextKey: string): void;
    queuePendingEmbeddedAnnotationDelete(comment: IAnnotationCommentSummary): boolean;
    unqueuePendingEmbeddedAnnotationDelete(stableKey: string): void;
    getPendingEmbeddedMutationSnapshot(): IAnnotationPendingEmbeddedMutationSnapshot;
    flushForSave(): Promise<unknown>;
    consumePendingEmbeddedMutations(): IConsumedAnnotationEmbeddedMutations;
}

export interface IUseAnnotationMutationServiceOptions {
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    updateSelectedTextMarkupAnnotationColor: (color: string) => ITextMarkupColorMutationResult;
    updateTextMarkupAnnotationColor: (comment: IAnnotationCommentSummary, color: string) => ITextMarkupColorMutationResult;
    markAnnotationLocallyDeleted: (comment: IAnnotationCommentSummary) => void;
    restoreAnnotationLocally: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromInternalCache: (stableKey: string) => void;
    findAnnotationCommentByStableKey?: (stableKey: string) => IAnnotationCommentSummary | null;
    clearPendingMarkerMoves: () => void;
    handleMarkerMove: (
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        options?: IAnnotationMarkerMoveOptions,
    ) => boolean;
    findEditorForComment: (comment: IAnnotationCommentSummary) => IPdfjsEditor | null;
    addPendingCommentEditorKey: (key: string) => void;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
    markModified: () => void;
    suppressManagedAnnotationId: (annotationId: string) => void;
    unsuppressManagedAnnotationId: (annotationId: string) => void;
    suppressCommentAnnotationId: (annotationId: string) => void;
    unsuppressCommentAnnotationId: (annotationId: string) => void;
    suppressAnnotationStableKey: (stableKey: string) => void;
    unsuppressAnnotationStableKey: (stableKey: string) => void;
    flushAnnotationCommentsForSave: () => Promise<unknown>;
    consumePendingEmbeddedMutations?: () => IConsumedAnnotationEmbeddedMutations;
}
