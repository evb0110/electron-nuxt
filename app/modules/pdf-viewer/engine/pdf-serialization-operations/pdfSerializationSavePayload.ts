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
import type { IPdfSerializedPlacedImagePayload } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-placed-images/pdfSerializedPlacedImagePayload';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';

export interface IPdfSerializationSavePayload {
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
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
    pageLabelsDirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    totalPages: number;
    bookmarksDirty: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
    placedImage: IPdfSerializedPlacedImagePayload | null;
}
