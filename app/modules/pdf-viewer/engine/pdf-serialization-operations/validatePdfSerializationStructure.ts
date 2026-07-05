import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import { readManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/readManagedShapeStableKey';
import { normalizeManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/normalizeManagedShapeStableKey';
import { toFreeTextNoteMarkerRect } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { getPdfStringValue } from '@app/utils/pdfDict';

const MAX_FREETEXT_NOTE_MARKER_SIZE = 0.02;

export type TPdfSerializationStructuralCheck =
    | 'parse'
    | 'page-count'
    | 'page-tree'
    | 'annotation-preservation'
    | 'new-annotation'
    | 'freetext-note';

export interface IPdfSerializationStructuralValidationFailure {
    check: TPdfSerializationStructuralCheck;
    message: string;
    ref?: string;
    pageIndex?: number;
}

export interface IPdfSerializationStructuralValidationResult {
    ok: boolean;
    failures: IPdfSerializationStructuralValidationFailure[];
}

interface IPageAnnotationSnapshot {
    byRef: Map<string, {
        dict: PDFDict | null;
        pageIndex: number;
        ref: PDFRef;
    }>;
    refsByPage: Map<number, Set<string>>;
    stampNamePrefixesByPage: Map<number, Map<string, number>>;
}

function createFailure(
    check: TPdfSerializationStructuralCheck,
    message: string,
    options: Pick<IPdfSerializationStructuralValidationFailure, 'ref' | 'pageIndex'> = {},
): IPdfSerializationStructuralValidationFailure {
    return {
        check,
        message,
        ...options,
    };
}

async function loadPdfForValidation(
    bytes: Uint8Array,
    label: string,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        doc.getPages();
        return doc;
    } catch (error) {
        failures.push(createFailure('parse', `${label} PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`));
        return null;
    }
}

function toPdfRef(annotationId: string | null | undefined) {
    const parsed = parsePdfJsAnnotationRef(annotationId);
    return parsed ? PDFRef.of(parsed.objectNumber, parsed.generationNumber) : null;
}

function getAnnotationDict(doc: PDFDocument, ref: PDFRef) {
    return doc.context.lookupMaybe(ref, PDFDict) ?? null;
}

function collectPageAnnotationSnapshot(doc: PDFDocument): IPageAnnotationSnapshot {
    const byRef = new Map<string, {
        dict: PDFDict | null;
        pageIndex: number;
        ref: PDFRef;
    }>();
    const refsByPage = new Map<number, Set<string>>();
    const stampNamePrefixesByPage = new Map<number, Map<string, number>>();

    doc.getPages().forEach((page, pageIndex) => {
        const pageRefs = new Set<string>();
        const stampPrefixes = new Map<string, number>();
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            refsByPage.set(pageIndex, pageRefs);
            stampNamePrefixesByPage.set(pageIndex, stampPrefixes);
            return;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const value = annots.get(index);
            if (!(value instanceof PDFRef)) {
                continue;
            }
            const ref = value.toString();
            const dict = getAnnotationDict(doc, value);
            pageRefs.add(ref);
            byRef.set(ref, {
                dict,
                pageIndex,
                ref: value,
            });

            if (dict?.get(PDFName.of('Subtype'))?.toString() === '/Stamp') {
                const name = getPdfStringValue(dict.get(PDFName.of('NM')));
                if (name.startsWith('placed-image-')) {
                    stampPrefixes.set('placed-image-', (stampPrefixes.get('placed-image-') ?? 0) + 1);
                }
            }
        }
        refsByPage.set(pageIndex, pageRefs);
        stampNamePrefixesByPage.set(pageIndex, stampPrefixes);
    });

    return {
        byRef,
        refsByPage,
        stampNamePrefixesByPage,
    };
}

function collectAnnotationFamilyRefs(doc: PDFDocument, ref: PDFRef) {
    const refs = new Set<PDFRef>([ref]);
    const dict = getAnnotationDict(doc, ref);
    const popup = dict?.get(PDFName.of('Popup'));
    if (popup instanceof PDFRef) {
        refs.add(popup);
    }
    return refs;
}

function collectDeletedAnnotationRefs(source: PDFDocument, sourceSnapshot: IPageAnnotationSnapshot, payload: IPdfSerializationSavePayload) {
    const deletedRefs = new Set<string>();
    for (const annotationId of payload.deletedShapeAnnotationIds) {
        const ref = toPdfRef(annotationId);
        if (ref) {
            collectAnnotationFamilyRefs(source, ref).forEach(familyRef => deletedRefs.add(familyRef.toString()));
        }
    }
    for (const comment of payload.pendingEmbeddedAnnotationDeletes) {
        const ref = toPdfRef(comment.annotationId);
        if (ref) {
            collectAnnotationFamilyRefs(source, ref).forEach(familyRef => deletedRefs.add(familyRef.toString()));
        }
    }

    const deletedStableKeys = new Set(
        payload.deletedShapeStableKeys
            .map(stableKey => normalizeManagedShapeStableKey(stableKey))
            .filter((stableKey): stableKey is string => Boolean(stableKey)),
    );
    if (deletedStableKeys.size === 0) {
        return deletedRefs;
    }

    for (const annotation of sourceSnapshot.byRef.values()) {
        const stableKey = readManagedShapeStableKey(annotation.dict);
        if (stableKey && deletedStableKeys.has(stableKey)) {
            collectAnnotationFamilyRefs(source, annotation.ref).forEach(familyRef => deletedRefs.add(familyRef.toString()));
        }
    }

    return deletedRefs;
}

function checkPageCount(
    sourceDoc: PDFDocument,
    outputDoc: PDFDocument,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    const expectedPageCount = sourceDoc.getPageCount();
    const actualPageCount = outputDoc.getPageCount();
    if (actualPageCount !== expectedPageCount) {
        failures.push(createFailure('page-count', `expected ${expectedPageCount} pages but found ${actualPageCount}`));
    }
}

function checkPageTree(
    outputDoc: PDFDocument,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    try {
        const pages = outputDoc.getPages();
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            page.node.Annots();
            if (page.getWidth() <= 0 || page.getHeight() <= 0) {
                failures.push(createFailure('page-tree', `page ${pageIndex + 1} has invalid dimensions`, { pageIndex }));
            }
        }
    } catch (error) {
        failures.push(createFailure('page-tree', `output PDF page tree could not be walked: ${error instanceof Error ? error.message : String(error)}`));
    }
}

function checkAnnotationPreservation(
    sourceDoc: PDFDocument,
    sourceSnapshot: IPageAnnotationSnapshot,
    outputSnapshot: IPageAnnotationSnapshot,
    payload: IPdfSerializationSavePayload,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    const deletedRefs = collectDeletedAnnotationRefs(sourceDoc, sourceSnapshot, payload);
    for (const [
        ref,
        annotation,
    ] of sourceSnapshot.byRef) {
        if (deletedRefs.has(ref)) {
            continue;
        }
        if (!outputSnapshot.byRef.has(ref)) {
            failures.push(createFailure('annotation-preservation', `annotation ref ${ref} is missing after serialization`, {
                ref,
                pageIndex: annotation.pageIndex,
            }));
        }
    }
}

function getPendingText(commentId: string | null | undefined, pendingTextByKey: Map<string, string>) {
    return commentId ? pendingTextByKey.get(commentId) : undefined;
}

function resolveExpectedFreeText(comment: IPdfSerializationSavePayload['freeTextComments'][number], pendingTextByKey: Map<string, string>) {
    return getPendingText(comment.stableKey, pendingTextByKey)
        ?? getPendingText(comment.id, pendingTextByKey)
        ?? getPendingText(comment.annotationId, pendingTextByKey)
        ?? comment.text
        ?? '';
}

function isProcessedFreeTextNoteComment(comment: IPdfSerializationSavePayload['freeTextComments'][number]) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return Boolean(comment.hasNote)
        && Boolean(toFreeTextNoteMarkerRect(comment.markerRect))
        && (subtype === 'freetext' || subtype === 'typewriter');
}

function hasNormalAppearance(doc: PDFDocument, dict: PDFDict) {
    const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
    if (!(ap instanceof PDFDict)) {
        return false;
    }
    const normalAppearance = ap.get(PDFName.of('N'));
    if (normalAppearance instanceof PDFDict || normalAppearance instanceof PDFStream) {
        return true;
    }
    if (!(normalAppearance instanceof PDFRef)) {
        return false;
    }
    const resolvedAppearance = doc.context.lookup(normalAppearance);
    return resolvedAppearance instanceof PDFDict || resolvedAppearance instanceof PDFStream;
}

function getRectSizeClass(doc: PDFDocument, dict: PDFDict, pageIndex: number) {
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }
    const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!(rect instanceof PDFArray) || rect.size() < 4) {
        return null;
    }

    const numbers: number[] = [];
    for (let index = 0; index < 4; index += 1) {
        const value = rect.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        numbers.push(value.asNumber());
    }

    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    if (pageWidth <= 0 || pageHeight <= 0) {
        return null;
    }

    return {
        width: Math.abs(numbers[2]! - numbers[0]!) / pageWidth,
        height: Math.abs(numbers[3]! - numbers[1]!) / pageHeight,
    };
}

function checkFreeTextNoteDict(
    outputDoc: PDFDocument,
    dict: PDFDict,
    pageIndex: number,
    ref: string,
    expectedText: string,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    if (dict.get(PDFName.of('Subtype'))?.toString() !== '/FreeText') {
        failures.push(createFailure('freetext-note', `FreeText note ${ref} no longer has /FreeText subtype`, {
            ref,
            pageIndex,
        }));
        return;
    }

    if (expectedText.trim().length > 0 && getPdfStringValue(dict.get(PDFName.of('Contents'))).trim().length === 0) {
        failures.push(createFailure('freetext-note', `FreeText note ${ref} has empty /Contents after text was written`, {
            ref,
            pageIndex,
        }));
    }

    if (!hasNormalAppearance(outputDoc, dict)) {
        failures.push(createFailure('freetext-note', `FreeText note ${ref} is missing a normal appearance stream`, {
            ref,
            pageIndex,
        }));
    }

    const rectSize = getRectSizeClass(outputDoc, dict, pageIndex);
    if (
        !rectSize
        || rectSize.width > MAX_FREETEXT_NOTE_MARKER_SIZE
        || rectSize.height > MAX_FREETEXT_NOTE_MARKER_SIZE
    ) {
        failures.push(createFailure('freetext-note', `FreeText note ${ref} rect is outside the note-marker size class`, {
            ref,
            pageIndex,
        }));
    }
}

function findLocalFreeTextNote(
    outputSnapshot: IPageAnnotationSnapshot,
    pageIndex: number,
    text: string,
    claimedRefs: Set<string>,
) {
    for (const ref of outputSnapshot.refsByPage.get(pageIndex) ?? []) {
        if (claimedRefs.has(ref)) {
            continue;
        }
        const annotation = outputSnapshot.byRef.get(ref);
        const dict = annotation?.dict ?? null;
        if (
            dict?.get(PDFName.of('Subtype'))?.toString() === '/FreeText'
            && getPdfStringValue(dict.get(PDFName.of('Contents'))) === text
        ) {
            claimedRefs.add(ref);
            return {
                ref,
                dict,
                pageIndex,
            };
        }
    }
    return null;
}

function checkFreeTextNoteInvariants(
    outputDoc: PDFDocument,
    outputSnapshot: IPageAnnotationSnapshot,
    payload: IPdfSerializationSavePayload,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    const pendingTextByKey = new Map(payload.pendingEmbeddedTextUpdates);
    const claimedLocalRefs = new Set<string>();

    for (const comment of payload.freeTextComments) {
        if (!isProcessedFreeTextNoteComment(comment)) {
            continue;
        }

        const expectedText = resolveExpectedFreeText(comment, pendingTextByKey);
        const ref = toPdfRef(comment.annotationId);
        if (ref) {
            const refTag = ref.toString();
            const annotation = outputSnapshot.byRef.get(refTag);
            if (!annotation?.dict) {
                failures.push(createFailure('freetext-note', `processed FreeText note ${refTag} is missing`, {
                    ref: refTag,
                    pageIndex: comment.pageIndex,
                }));
                continue;
            }
            checkFreeTextNoteDict(outputDoc, annotation.dict, annotation.pageIndex, refTag, expectedText, failures);
            continue;
        }

        const localNote = findLocalFreeTextNote(outputSnapshot, comment.pageIndex, expectedText, claimedLocalRefs);
        if (!localNote) {
            failures.push(createFailure('new-annotation', 'new FreeText note annotation is missing after serialization', { pageIndex: comment.pageIndex }));
            continue;
        }
        checkFreeTextNoteDict(outputDoc, localNote.dict, localNote.pageIndex, localNote.ref, expectedText, failures);
    }
}

function checkNewManagedShapes(
    outputSnapshot: IPageAnnotationSnapshot,
    payload: IPdfSerializationSavePayload,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    const expectedStableKeys = payload.shapes
        .filter(shape => shape.source !== 'embedded' && !toPdfRef(shape.annotationId))
        .map(shape => normalizeManagedShapeStableKey(shape.stableKey))
        .filter((stableKey): stableKey is string => Boolean(stableKey));
    if (expectedStableKeys.length === 0) {
        return;
    }

    const presentStableKeys = new Set<string>();
    for (const annotation of outputSnapshot.byRef.values()) {
        const stableKey = readManagedShapeStableKey(annotation.dict);
        if (stableKey) {
            presentStableKeys.add(stableKey);
        }
    }

    expectedStableKeys.forEach((stableKey) => {
        if (!presentStableKeys.has(stableKey)) {
            failures.push(createFailure('new-annotation', `new managed shape annotation ${stableKey} is missing after serialization`));
        }
    });
}

function countStampPrefix(snapshot: IPageAnnotationSnapshot, pageIndex: number, prefix: string) {
    return snapshot.stampNamePrefixesByPage.get(pageIndex)?.get(prefix) ?? 0;
}

function checkNewPlacedImage(
    sourceSnapshot: IPageAnnotationSnapshot,
    outputSnapshot: IPageAnnotationSnapshot,
    payload: IPdfSerializationSavePayload,
    failures: IPdfSerializationStructuralValidationFailure[],
) {
    const placement = payload.placedImage;
    if (!placement) {
        return;
    }
    const pageIndex = placement.pageNumber - 1;
    const beforeCount = countStampPrefix(sourceSnapshot, pageIndex, 'placed-image-');
    const afterCount = countStampPrefix(outputSnapshot, pageIndex, 'placed-image-');
    if (afterCount <= beforeCount) {
        failures.push(createFailure('new-annotation', 'new placed-image stamp annotation is missing after serialization', { pageIndex }));
    }
}

export async function validatePdfSerializationStructure(
    sourceData: Uint8Array,
    outputData: Uint8Array,
    payload: IPdfSerializationSavePayload,
): Promise<IPdfSerializationStructuralValidationResult> {
    const failures: IPdfSerializationStructuralValidationFailure[] = [];
    const sourceDoc = await loadPdfForValidation(sourceData, 'source', failures);
    const outputDoc = await loadPdfForValidation(outputData, 'output', failures);
    if (!sourceDoc || !outputDoc) {
        return {
            ok: false,
            failures,
        };
    }

    const sourceSnapshot = collectPageAnnotationSnapshot(sourceDoc);
    const outputSnapshot = collectPageAnnotationSnapshot(outputDoc);

    checkPageCount(sourceDoc, outputDoc, failures);
    checkPageTree(outputDoc, failures);
    checkAnnotationPreservation(sourceDoc, sourceSnapshot, outputSnapshot, payload, failures);
    checkNewManagedShapes(outputSnapshot, payload, failures);
    checkNewPlacedImage(sourceSnapshot, outputSnapshot, payload, failures);
    checkFreeTextNoteInvariants(outputDoc, outputSnapshot, payload, failures);

    return {
        ok: failures.length === 0,
        failures,
    };
}
