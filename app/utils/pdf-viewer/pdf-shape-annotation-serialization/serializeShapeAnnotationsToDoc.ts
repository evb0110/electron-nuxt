import type { IShapeAnnotation } from '@app/types/annotations';
import { serializePdfEdits } from '@app/utils/pdf-viewer/pdf-serialization-operations/serializePdfEdits';
import type { IPdfSerializationSavePayload } from '@app/utils/pdf-viewer/pdf-serialization-operations/pdfSerializationSavePayload';
import { BrowserLogger } from '@app/utils/browserLogger';

const SHAPE_SERIALIZATION_LOG_SECTION = 'pdf-shapes';

function createShapeSerializationPayload(shapes: IShapeAnnotation[]): IPdfSerializationSavePayload {
    return {
        markupSubtypeOverrides: [],
        markupSubtypeHints: [],
        rewriteShapeState: true,
        shapes,
        deletedShapeAnnotationIds: [],
        deletedShapeStableKeys: [],
        freeTextComments: [],
        annotationComments: [],
        pendingEmbeddedTextUpdates: [],
        pendingEmbeddedAnnotationDeletes: [],
        pageLabelsDirty: false,
        pageLabelRanges: [],
        totalPages: 0,
        bookmarksDirty: false,
        bookmarkItems: [],
        untitledBookmarkLabel: '',
        placedImage: null,
    };
}

export async function serializeShapeAnnotationsToDoc(
    data: Uint8Array,
    shapes: IShapeAnnotation[],
) {
    if (shapes.length === 0) {
        return data;
    }

    try {
        return await serializePdfEdits(
            data,
            createShapeSerializationPayload(shapes),
        );
    } catch (error) {
        BrowserLogger.warn(
            SHAPE_SERIALIZATION_LOG_SECTION,
            'Failed to serialize PDF shape annotations',
            error,
        );
        return data;
    }
}
