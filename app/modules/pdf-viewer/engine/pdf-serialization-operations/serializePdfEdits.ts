import { PDFDocument } from 'pdf-lib';
import { applyEmbeddedAnnotationDeletes } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-embedded-notes/applyEmbeddedAnnotationDeletes';
import { applyEmbeddedNoteTextUpdates } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-embedded-notes/applyEmbeddedNoteTextUpdates';
import { applyFreeTextNoteRects } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-free-text/applyFreeTextNoteRects';
import { applyNewFreeTextNoteAnnotations } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-free-text/applyNewFreeTextNoteAnnotations';
import { applyMarkupSubtypeRewrites } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-markup/applyMarkupSubtypeRewrites';
import { applyBookmarks } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-outline/applyBookmarks';
import { applyPageLabels } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-outline/applyPageLabels';
import { applyPlacedImage } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-placed-images/applyPlacedImage';
import { applyShapeAnnotations } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shape-annotations/applyShapeAnnotations';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import {applyCanonicalAnnotationIdentityBindings} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';

function canonicalDeletePdfRef(mutation: IBackendAnnotationMutation) {
    const identity = mutation.fields.identity;
    const pdfRef = identity && typeof identity === 'object'
        ? (identity as Record<string, unknown>).pdfRef
        : null;
    return typeof pdfRef === 'string' ? pdfRef : null;
}

function canonicalShapeDeleteRefs(payload: IPdfSerializationSavePayload) {
    return (payload.canonicalAnnotationProgram ?? []).flatMap((mutation) => {
        if (mutation.operation !== 'delete-annotation' || mutation.fields.kind !== 'shape') {
            return [];
        }
        const pdfRef = canonicalDeletePdfRef(mutation);
        return pdfRef ? [pdfRef] : [];
    });
}

function canonicalEmbeddedDeletes(payload: IPdfSerializationSavePayload): IAnnotationCommentSummary[] {
    return (payload.canonicalAnnotationProgram ?? []).flatMap((mutation) => {
        if (mutation.operation !== 'delete-annotation' || mutation.fields.kind === 'shape') {
            return [];
        }
        const pageIndex = mutation.fields.pageIndex;
        const pdfRef = canonicalDeletePdfRef(mutation);
        if (typeof pdfRef !== 'string' || typeof pageIndex !== 'number') {
            return [];
        }
        return [{
            id: pdfRef,
            appAnnotationId: mutation.annotationId,
            stableKey: `ann:${pageIndex}:${pdfRef}`,
            pageIndex,
            pageNumber: pageIndex + 1,
            text: '',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: pdfRef,
            source: 'pdf',
            hasNote: false,
            markerRect: null,
        }];
    });
}

function hasSaveWork(payload: IPdfSerializationSavePayload) {
    return (payload.canonicalAnnotationProgram?.length ?? 0) > 0
        || Boolean(payload.forceRewrite)
        || payload.markupSubtypeOverrides.length > 0
        || payload.markupSubtypeHints.length > 0
        || payload.rewriteShapeState
        || payload.shapes.length > 0
        || payload.deletedShapeAnnotationIds.length > 0
        || payload.deletedShapeStableKeys.length > 0
        || payload.freeTextComments.length > 0
        || payload.pendingEmbeddedTextUpdates.length > 0
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
        [
            ...payload.deletedShapeAnnotationIds,
            ...canonicalShapeDeleteRefs(payload),
        ],
        payload.deletedShapeStableKeys,
        payload.rewriteShapeState,
    ) || modified;
    modified = applyEmbeddedAnnotationDeletes(doc, canonicalEmbeddedDeletes(payload)) || modified;
    modified = applyFreeTextNoteRects(doc, payload.freeTextComments) || modified;
    modified = applyNewFreeTextNoteAnnotations(doc, payload.freeTextComments) || modified;
    modified = applyEmbeddedNoteTextUpdates(doc, payload.annotationComments, payload.pendingEmbeddedTextUpdates) || modified;
    modified = applyCanonicalAnnotationIdentityBindings(
        doc,
        payload.annotationComments,
        payload.canonicalAnnotationProgram ?? [],
    ) || modified;
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
