import { PDFDocument } from 'pdf-lib';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
    updateAnnotationTextByRef,
} from '@app/composables/pdf/pdfSerializationComments';
import { resolveCommentPdfRefInDocument } from '@app/composables/pdf/pdfSerializationRefs';
import {
    applyEmbeddedAnnotationDeletes,
    applyEmbeddedNoteTextUpdates,
} from './serialization/pdfSerializationEmbeddedNotes';
import {
    applyFreeTextNoteRects,
    applyNewFreeTextNoteAnnotations,
} from './serialization/pdfSerializationFreeText';
import { applyMarkupSubtypeRewrites } from './serialization/pdfSerializationMarkup';
import {
    applyBookmarks,
    applyPageLabels,
} from './serialization/pdfSerializationOutline';
import {
    applyPlacedImage,
    type IPdfSerializedPlacedImagePayload,
} from './serialization/pdfSerializationPlacedImages';
import { applyShapeAnnotations } from './serialization/pdfSerializationShapes';

export type { IPdfSerializedPlacedImagePayload } from './serialization/pdfSerializationPlacedImages';

export interface IPdfSerializationSavePayload {
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

function hasSaveWork(payload: IPdfSerializationSavePayload) {
    return payload.markupSubtypeOverrides.length > 0
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

    if (!modified) {
        return data;
    }

    return new Uint8Array(await doc.save());
}

export async function updateEmbeddedAnnotationText(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
    text: string,
) {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const targetRef = resolveCommentPdfRefInDocument(doc, comment);
    if (!targetRef) {
        return null;
    }

    if (!updateAnnotationTextByRef(doc, targetRef, text)) {
        return null;
    }

    return new Uint8Array(await doc.save());
}

export async function deleteEmbeddedAnnotation(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
) {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const targetRef = resolveCommentPdfRefInDocument(doc, comment);
    if (!targetRef) {
        return null;
    }

    const refsToDelete = collectAnnotationRefsToDelete(doc, targetRef);
    if (!removeAnnotationRefsFromPages(doc, refsToDelete)) {
        return null;
    }

    return new Uint8Array(await doc.save());
}
