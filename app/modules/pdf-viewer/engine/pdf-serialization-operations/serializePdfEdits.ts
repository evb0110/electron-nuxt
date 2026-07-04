import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
} from 'pdf-lib';
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
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

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

function getPdfTextValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

function toPdfRef(annotationId: string | null | undefined) {
    const parsed = parsePdfJsAnnotationRef(annotationId);
    return parsed ? PDFRef.of(parsed.objectNumber, parsed.generationNumber) : null;
}

function getPageAnnotationRefs(doc: PDFDocument, pageIndex: number) {
    if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
        return new Set<string>();
    }
    const annots = doc.getPage(pageIndex).node.Annots();
    if (!(annots instanceof PDFArray)) {
        return new Set<string>();
    }

    const refs = new Set<string>();
    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (value instanceof PDFRef) {
            refs.add(value.toString());
        }
    }
    return refs;
}

function getAnnotationDict(doc: PDFDocument, ref: PDFRef) {
    return doc.context.lookupMaybe(ref, PDFDict) ?? null;
}

function isFreeTextComment(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.toLowerCase();
    return subtype === 'freetext' || subtype === 'typewriter';
}

function resolveExpectedFreeTextContents(
    comment: IAnnotationCommentSummary,
    pendingTextByKey: Map<string, string>,
) {
    return pendingTextByKey.get(comment.stableKey)
        ?? pendingTextByKey.get(comment.id)
        ?? pendingTextByKey.get(comment.annotationId ?? '')
        ?? comment.text;
}

function collectDeletedAnnotationRefs(payload: IPdfSerializationSavePayload) {
    const deletedRefs = new Set<string>();
    for (const annotationId of payload.deletedShapeAnnotationIds) {
        const ref = toPdfRef(annotationId);
        if (ref) {
            deletedRefs.add(ref.toString());
        }
    }
    for (const comment of payload.pendingEmbeddedAnnotationDeletes) {
        const ref = toPdfRef(comment.annotationId);
        if (ref) {
            deletedRefs.add(ref.toString());
        }
    }
    return deletedRefs;
}

async function assertSerializedAnnotationSemantics(
    data: Uint8Array,
    payload: IPdfSerializationSavePayload,
) {
    const deletedRefs = collectDeletedAnnotationRefs(payload);
    const expectedComments = payload.annotationComments.filter((comment) => {
        const ref = toPdfRef(comment.annotationId);
        return ref && !deletedRefs.has(ref.toString());
    });
    const expectedShapes = payload.shapes.filter((shape) => {
        const ref = toPdfRef(shape.annotationId);
        return shape.source === 'embedded' && ref && !deletedRefs.has(ref.toString());
    });
    const pendingTextByKey = new Map(payload.pendingEmbeddedTextUpdates);
    const expectedFreeTextComments = payload.freeTextComments.filter((comment) => {
        const ref = toPdfRef(comment.annotationId);
        return ref && !deletedRefs.has(ref.toString());
    });
    if (
        expectedComments.length === 0
        && expectedShapes.length === 0
        && expectedFreeTextComments.length === 0
    ) {
        return;
    }

    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const failures: string[] = [];

    for (const shape of expectedShapes) {
        const ref = toPdfRef(shape.annotationId);
        if (!ref) {
            continue;
        }
        const pageRefs = getPageAnnotationRefs(doc, shape.pageIndex);
        if (!pageRefs.has(ref.toString())) {
            failures.push(`missing shape annotation ref ${ref.toString()} on page ${shape.pageIndex + 1}`);
        }
    }

    for (const comment of expectedComments) {
        const ref = toPdfRef(comment.annotationId);
        if (!ref) {
            continue;
        }
        const pageRefs = getPageAnnotationRefs(doc, comment.pageIndex);
        const dict = getAnnotationDict(doc, ref);
        if (!pageRefs.has(ref.toString()) || !dict) {
            failures.push(`missing annotation ref ${ref.toString()} on page ${comment.pageNumber}`);
            continue;
        }
        if (comment.annotationName) {
            const actualName = getPdfTextValue(dict.get(PDFName.of('NM')));
            if (actualName !== comment.annotationName) {
                failures.push(`annotation ${ref.toString()} lost NM key ${comment.annotationName}`);
            }
        }
    }

    for (const comment of expectedFreeTextComments) {
        const ref = toPdfRef(comment.annotationId);
        if (!ref) {
            continue;
        }
        const dict = getAnnotationDict(doc, ref);
        if (!dict) {
            failures.push(`missing FreeText annotation ref ${ref.toString()}`);
            continue;
        }
        if (dict.get(PDFName.of('Subtype'))?.toString() !== '/FreeText') {
            failures.push(`annotation ${ref.toString()} is no longer FreeText`);
            continue;
        }
        if (!comment.hasNote && !isFreeTextComment(comment)) {
            continue;
        }
        const expectedContents = resolveExpectedFreeTextContents(comment, pendingTextByKey);
        const actualContents = getPdfTextValue(dict.get(PDFName.of('Contents')));
        if (actualContents !== expectedContents) {
            failures.push(`FreeText annotation ${ref.toString()} lost expected contents`);
        }
    }

    if (failures.length > 0) {
        throw new Error(`PDF serialization failed semantic annotation validation: ${failures.join('; ')}`);
    }
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

    const result = new Uint8Array(await doc.save());
    await assertSerializedAnnotationSemantics(result, payload);
    return result;
}
