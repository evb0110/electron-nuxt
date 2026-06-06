import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import type { IMarkupSubtypeHint } from '@app/utils/pdf-viewer/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { IPdfSerializedPlacedImagePayload } from '@app/utils/pdf-viewer/serialization/pdf-serialization-placed-images/pdfSerializationPlacedImagesTypes';

export interface IPdfSerializationSavePayload {
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
