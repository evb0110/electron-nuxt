import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import { validatePdfSerializationStructure } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/validatePdfSerializationStructure';

function createEmptyPayload(): IPdfSerializationSavePayload {
    return {
        forceRewrite: true,
        markupSubtypeOverrides: [],
        markupSubtypeHints: [],
        rewriteShapeState: false,
        shapes: [],
        deletedShapeAnnotationIds: [],
        deletedShapeStableKeys: [],
        freeTextComments: [],
        annotationComments: [],
        pendingEmbeddedTextUpdates: [],
        pendingEmbeddedAnnotationDeletes: [],
        pageLabelsDirty: false,
        pageLabelRanges: [],
        totalPages: 1,
        bookmarksDirty: false,
        bookmarkItems: [],
        untitledBookmarkLabel: '',
        placedImage: null,
    };
}

function toAnnotationId(ref: PDFRef) {
    return `${ref.objectNumber}R${ref.generationNumber}`;
}

function createAnnotationComment(ref: PDFRef): IAnnotationCommentSummary {
    return {
        id: toAnnotationId(ref),
        stableKey: `ann:0:${toAnnotationId(ref)}`,
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: 'delete me',
        kindLabel: 'Note',
        subtype: 'Text',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: toAnnotationId(ref),
        source: 'pdf',
        hasNote: true,
        markerRect: null,
    };
}

function removePageAnnotationRef(doc: PDFDocument, ref: PDFRef) {
    const annots = doc.getPage(0).node.Annots();
    if (!(annots instanceof PDFArray)) {
        return;
    }
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
        const value = annots.get(index);
        if (value instanceof PDFRef && value.toString() === ref.toString()) {
            annots.remove(index);
        }
    }
}

async function createPdfWithTextAnnotation() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const annotRef = doc.context.register(doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        Rect: [
            72,
            640,
            96,
            664,
        ],
        Contents: 'keep me',
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    return {
        bytes: new Uint8Array(await doc.save()),
        annotRef,
    };
}

async function removeAnnotationFromBytes(bytes: Uint8Array, ref: PDFRef) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    removePageAnnotationRef(doc, ref);
    return new Uint8Array(await doc.save());
}

async function createTwoPagePdf() {
    const doc = await PDFDocument.create();
    doc.addPage([
        600,
        800,
    ]);
    doc.addPage([
        600,
        800,
    ]);
    return new Uint8Array(await doc.save());
}

async function removeSecondPage(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    doc.removePage(1);
    return new Uint8Array(await doc.save());
}

async function createPdfWithFreeTextNote() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const blankApRef = doc.context.register(doc.context.formXObject([], {}));
    const freeTextDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('FreeText'),
        Rect: [
            PDFNumber.of(72),
            PDFNumber.of(640),
            PDFNumber.of(73),
            PDFNumber.of(641),
        ],
        Contents: PDFHexString.fromText('note text'),
        AP: doc.context.obj({ N: blankApRef }),
    });
    const freeTextRef = doc.context.register(freeTextDict);
    const popupRef = doc.context.register(doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Popup'),
        Parent: freeTextRef,
        Rect: [
            PDFNumber.of(72),
            PDFNumber.of(640),
            PDFNumber.of(73),
            PDFNumber.of(641),
        ],
    }));
    freeTextDict.set(PDFName.of('Popup'), popupRef);
    page.node.set(PDFName.of('Annots'), doc.context.obj([
        freeTextRef,
        popupRef,
    ]));
    return {
        bytes: new Uint8Array(await doc.save()),
        freeTextRef,
    };
}

async function removeFreeTextAppearance(bytes: Uint8Array, ref: PDFRef) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const dict = doc.context.lookupMaybe(ref, PDFDict);
    dict?.delete(PDFName.of('AP'));
    return new Uint8Array(await doc.save());
}

function createFreeTextComment(ref: PDFRef): IAnnotationCommentSummary {
    return {
        id: toAnnotationId(ref),
        stableKey: `ann:0:${toAnnotationId(ref)}`,
        sortIndex: null,
        pageIndex: 0,
        pageNumber: 1,
        text: 'note text',
        kindLabel: 'Inline Note',
        subtype: 'FreeText',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: toAnnotationId(ref),
        source: 'pdf',
        hasNote: true,
        markerRect: {
            left: 0.12,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        },
    };
}

describe('validatePdfSerializationStructure', () => {
    it('rejects serialized output missing a previously present annotation ref', async () => {
        const {
            bytes,
            annotRef,
        } = await createPdfWithTextAnnotation();
        const output = await removeAnnotationFromBytes(bytes, annotRef);
        const validation = await validatePdfSerializationStructure(bytes, output, createEmptyPayload());

        expect(validation.ok).toBe(false);
        expect(validation.failures).toEqual(expect.arrayContaining([expect.objectContaining({
            check: 'annotation-preservation',
            ref: annotRef.toString(),
        })]));
    });

    it('rejects serialized output with the wrong page count', async () => {
        const source = await createTwoPagePdf();
        const output = await removeSecondPage(source);
        const validation = await validatePdfSerializationStructure(source, output, createEmptyPayload());

        expect(validation.ok).toBe(false);
        expect(validation.failures).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'page-count' })]));
    });

    it('allows a valid save with a deleted annotation in the operation set', async () => {
        const {
            bytes,
            annotRef,
        } = await createPdfWithTextAnnotation();
        const output = await removeAnnotationFromBytes(bytes, annotRef);
        const payload = createEmptyPayload();
        payload.pendingEmbeddedAnnotationDeletes = [createAnnotationComment(annotRef)];
        const validation = await validatePdfSerializationStructure(bytes, output, payload);

        expect(validation).toEqual({
            ok: true,
            failures: [],
        });
    });

    it('rejects a FreeText note-marker invariant violation', async () => {
        const {
            bytes,
            freeTextRef,
        } = await createPdfWithFreeTextNote();
        const output = await removeFreeTextAppearance(bytes, freeTextRef);
        const payload = createEmptyPayload();
        payload.freeTextComments = [createFreeTextComment(freeTextRef)];
        const validation = await validatePdfSerializationStructure(bytes, output, payload);

        expect(validation.ok).toBe(false);
        expect(validation.failures).toEqual(expect.arrayContaining([expect.objectContaining({
            check: 'freetext-note',
            ref: freeTextRef.toString(),
        })]));
    });
});
