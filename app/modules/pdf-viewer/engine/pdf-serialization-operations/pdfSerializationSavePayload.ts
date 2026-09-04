import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';

export interface IPdfSerializationSavePayload {
    /** Kept as a null-only compatibility field for callers that build the old payload shape. */
    placedImage?: null;
    canonicalAnnotationProgram?: readonly IBackendAnnotationMutation[];
    forceRewrite?: boolean;
    markupSubtypeOverrides: Array<readonly [string, TMarkupSubtype]>;
    markupSubtypeHints: IMarkupSubtypeHint[];
    rewriteShapeState: boolean;
    shapes: IShapeAnnotation[];
    deletedShapeAnnotationIds: string[];
    deletedShapeStableKeys: string[];
    freeTextComments: IAnnotationCommentSummary[];
    annotationComments: IAnnotationCommentSummary[];
    pendingEmbeddedTextUpdates: Array<readonly [string, string]>;
    pageLabelsDirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    totalPages: number;
    bookmarksDirty: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
}
