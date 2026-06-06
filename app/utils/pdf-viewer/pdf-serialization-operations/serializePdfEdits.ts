import { PDFDocument } from 'pdf-lib';
import { applyEmbeddedAnnotationDeletes } from '@app/utils/pdf-viewer/serialization/pdf-serialization-embedded-notes/applyEmbeddedAnnotationDeletes';
import { applyEmbeddedNoteTextUpdates } from '@app/utils/pdf-viewer/serialization/pdf-serialization-embedded-notes/applyEmbeddedNoteTextUpdates';
import { applyFreeTextNoteRects } from '@app/utils/pdf-viewer/serialization/pdf-serialization-free-text/applyFreeTextNoteRects';
import { applyNewFreeTextNoteAnnotations } from '@app/utils/pdf-viewer/serialization/pdf-serialization-free-text/applyNewFreeTextNoteAnnotations';
import { applyMarkupSubtypeRewrites } from '@app/utils/pdf-viewer/serialization/pdf-serialization-markup/applyMarkupSubtypeRewrites';
import { applyBookmarks } from '@app/utils/pdf-viewer/serialization/pdf-serialization-outline/applyBookmarks';
import { applyPageLabels } from '@app/utils/pdf-viewer/serialization/pdf-serialization-outline/applyPageLabels';
import { applyPlacedImage } from '@app/utils/pdf-viewer/serialization/pdf-serialization-placed-images/applyPlacedImage';
import { applyShapeAnnotations } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shape-annotations/applyShapeAnnotations';
import type { IPdfSerializationSavePayload } from '@app/utils/pdf-viewer/pdf-serialization-operations/pdfSerializationOperationsTypes';

function hasSaveWork(payload: IPdfSerializationSavePayload) {
    return Boolean(payload.forceRewrite)
        || payload.markupSubtypeOverrides.length > 0
        || payload.markupSubtypeHints.length > 0
        || payload.rewriteShapeState
        || payload.shapes.length > 0
        || payload.deletedShapeAnnotationIds.length > 0
        || payload.deletedShapeStableKeys.length > 0
        || payload.freeTextComments.length > 0
        || payload.pendingEmbeddedTextUpdates.length > 0
        || payload.pendingEmbeddedAnnotationDeletes.length > 0
        || payload.pageLabelsDirty
        || payload.bookmarksDirty
        || Boolean(payload.placedImage);
}

export async function serializePdfEdits(
    data: Uint8Array,
    payload: IPdfSerializationSavePayload,
) {
    if (!hasSaveWork(payload)) {
        return data;
    }

    const doc = await PDFDocument.load(data, { updateMetadata: false });
    let modified = false;

    modified = applyMarkupSubtypeRewrites(doc, payload.markupSubtypeOverrides, payload.markupSubtypeHints) || modified;
    modified = applyShapeAnnotations(
        doc,
        payload.shapes,
        payload.deletedShapeAnnotationIds,
        payload.deletedShapeStableKeys,
        payload.rewriteShapeState,
    ) || modified;
    modified = applyEmbeddedAnnotationDeletes(doc, payload.pendingEmbeddedAnnotationDeletes) || modified;
    modified = applyFreeTextNoteRects(doc, payload.freeTextComments) || modified;
    modified = applyNewFreeTextNoteAnnotations(doc, payload.freeTextComments) || modified;
    modified = applyEmbeddedNoteTextUpdates(doc, payload.annotationComments, payload.pendingEmbeddedTextUpdates) || modified;
    modified = applyPageLabels(doc, payload.pageLabelsDirty, payload.pageLabelRanges, payload.totalPages) || modified;
    modified = applyBookmarks(
        doc,
        payload.bookmarksDirty,
        payload.bookmarkItems,
        payload.totalPages,
        payload.untitledBookmarkLabel,
    ) || modified;
    modified = await applyPlacedImage(doc, payload.placedImage) || modified;

    if (!modified && !payload.forceRewrite) {
        return data;
    }

    return new Uint8Array(await doc.save());
}
