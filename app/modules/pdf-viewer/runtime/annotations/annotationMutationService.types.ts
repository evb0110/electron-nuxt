import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { ITextMarkupColorMutationResult } from '@app/modules/pdf-viewer/annotations/usePdfAnnotationColorCommands';
import type { IAnnotationMutationVisualEffectsState } from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';
import type { AnnotationId } from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';

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

export interface IAnnotationMarkerMoveOptions {
    markEditorPending?: (
        updated: IAnnotationCommentSummary,
        original: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
    ) => void;
    markModified?: () => void;
}

export interface IAnnotationMutationService {
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
    deleteEmbeddedAnnotationDeferred(comment: IAnnotationCommentSummary): boolean;
    flushForSave(): Promise<unknown>;
}

export interface IUseAnnotationMutationServiceOptions {
    runHistoryTransaction?: <T>(action: () => T) => T;
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
    findEditorForComment: (comment: IAnnotationCommentSummary) => object | null;
    markModified: () => void;
    flushAnnotationCommentsForSave: () => Promise<unknown>;
    resolveCanonicalAnnotationId?: (comment: IAnnotationCommentSummary) => AnnotationId | null;
    setCanonicalNoteText: (id: AnnotationId, text: string) => void;
    deleteCanonicalAnnotation: (id: AnnotationId) => void;
    setCanonicalColor: (id: AnnotationId, color: string) => void;
    moveCanonicalAnchor: (id: AnnotationId, rect: IAnnotationMarkerRect) => void;
}
