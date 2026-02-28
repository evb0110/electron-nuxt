import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPageLabelRange } from '@app/types/pdf';
import { markerRectIoU } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    normalizePageRotation,
    toMarkerRectFromPdfRect,
    toPdfRectFromMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import { getPdfDictContents } from '@app/utils/pdf-dict';
import {
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';
import { resolveCommentPdfRefInDocument } from '@app/composables/pdf/pdfSerializationRefs';
import {
    updateAnnotationTextByRef,
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
} from '@app/composables/pdf/pdfSerializationComments';
import { serializeShapeAnnotationsToDoc } from '@app/composables/pdf/pdfSerializationShapes';
import {
    collectMarkupSubtypeHints,
    groupMarkupSubtypeHintsByPage,
} from '@app/composables/pdf/pdfSerializationSubtypeHints';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';

export {
    getPdfPopupDict, parsePdfJsAnnotationRef, resolveCommentPdfRefInDocument,
} from '@app/composables/pdf/pdfSerializationRefs';
export {
    setAnnotationDictContents, updateAnnotationTextByRef, collectAnnotationRefsToDelete, removeAnnotationRefsFromPages,
} from '@app/composables/pdf/pdfSerializationComments';
export { serializeShapeAnnotationsToDoc } from '@app/composables/pdf/pdfSerializationShapes';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

const PDF_SERIALIZATION_LOG_SECTION = 'pdf-serialization';
const RECT_NAME = PDFName.of('Rect');

function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

function resolvePdfPageView(page: ReturnType<PDFDocument['getPages']>[number]) {
    const fallbackSize = page.getSize();
    if (fallbackSize.width <= 0 || fallbackSize.height <= 0) {
        return null;
    }

    const fallbackView: [number, number, number, number] = [
        0,
        0,
        fallbackSize.width,
        fallbackSize.height,
    ];

    const box = (
        page.node.lookupMaybe(PDFName.of('CropBox'), PDFArray)
        ?? page.node.lookupMaybe(PDFName.of('MediaBox'), PDFArray)
    );
    if (!(box instanceof PDFArray) || box.size() < 4) {
        return fallbackView;
    }

    const x1 = numberFromPdfBox(box, 0);
    const y1 = numberFromPdfBox(box, 1);
    const x2 = numberFromPdfBox(box, 2);
    const y2 = numberFromPdfBox(box, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return fallbackView;
    }

    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);
    if ((maxX - minX) <= 0 || (maxY - minY) <= 0) {
        return fallbackView;
    }

    return [
        minX,
        minY,
        maxX,
        maxY,
    ];
}

function readPdfRectFromDict(dict: PDFDict): [number, number, number, number] | null {
    const rect = dict.lookupMaybe(RECT_NAME, PDFArray);
    if (!(rect instanceof PDFArray) || rect.size() < 4) {
        return null;
    }

    const x1 = numberFromPdfBox(rect, 0);
    const y1 = numberFromPdfBox(rect, 1);
    const x2 = numberFromPdfBox(rect, 2);
    const y2 = numberFromPdfBox(rect, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return null;
    }

    return [
        x1,
        y1,
        x2,
        y2,
    ];
}

export interface IPdfSerializationDeps {
    pdfData: Ref<Uint8Array | null>;
    workingCopyPath: Ref<string | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getAllShapes: () => IShapeAnnotation[];
}

export const usePdfSerialization = (deps: IPdfSerializationDeps) => {
    const {
        pdfData,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        getMarkupSubtypeOverrides,
        getAllShapes,
    } = deps;

    async function loadPdfDocument(
        data: Uint8Array,
        operation: string,
    ): Promise<PDFDocument | null> {
        try {
            return await PDFDocument.load(data, { updateMetadata: false });
        } catch (error) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, `Failed to load PDF while ${operation}`, error);
            return null;
        }
    }

    async function getSourcePdfData() {
        let sourceData = pdfData.value ? pdfData.value.slice() : null;
        if (!sourceData && workingCopyPath.value && hasElectronAPI()) {
            try {
                const buffer = await getElectronAPI().documents.readFile(workingCopyPath.value);
                sourceData = new Uint8Array(buffer);
            } catch (error) {
                BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Failed to read working copy for serialization', {
                    path: workingCopyPath.value,
                    error,
                });
                sourceData = null;
            }
        }
        return sourceData;
    }

    async function rewriteMarkupSubtypes(data: Uint8Array): Promise<Uint8Array> {
        const overrides = getMarkupSubtypeOverrides();
        const subtypeHints = collectMarkupSubtypeHints(annotationComments.value);

        if ((!overrides || overrides.size === 0) && subtypeHints.length === 0) {
            return data;
        }

        const doc = await loadPdfDocument(data, 'rewriting annotation subtypes');
        if (!doc) {
            return data;
        }
        const subtypeHintsByPage = groupMarkupSubtypeHintsByPage(subtypeHints);

        const subtypeName = PDFName.of('Subtype');
        const highlightName = PDFName.of('Highlight');
        let rewritten = false;

        const pages = doc.getPages();
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const pageHints = subtypeHintsByPage.get(pageIndex) ?? [];
            const pageView = resolvePdfPageView(page);
            if (!pageView) {
                continue;
            }
            const pageRotation = normalizePageRotation(page.getRotation().angle);
            const annots = page.node.Annots();
            if (!(annots instanceof PDFArray)) {
                continue;
            }

            for (let i = 0; i < annots.size(); i++) {
                const value = annots.get(i);
                const ref = value instanceof PDFRef ? value : null;
                if (!ref) {
                    continue;
                }

                const dict = doc.context.lookupMaybe(ref, PDFDict);
                if (!dict) {
                    continue;
                }

                const currentSubtype = dict.get(subtypeName);
                if (!(currentSubtype instanceof PDFName) || currentSubtype !== highlightName) {
                    continue;
                }

                const refTag = `${ref.objectNumber}R${ref.generationNumber}`;
                let targetSubtype = overrides?.get(refTag) ?? null;
                if (!targetSubtype && pageHints.length > 0) {
                    const markerRect = toMarkerRectFromPdfRect(
                        readPdfRectFromDict(dict),
                        pageView,
                        pageRotation,
                    );
                    let bestMatch: {
                        score: number;
                        hint: (typeof pageHints)[number];
                    } | null = null;
                    // Hints originate from editor-space rectangles; IoU matching
                    // tolerates small coordinate drift after save/restore.
                    for (const hint of pageHints) {
                        if (hint.consumed) {
                            continue;
                        }
                        const score = markerRectIoU(markerRect, hint.markerRect);
                        if (score <= 0) {
                            continue;
                        }
                        if (!bestMatch || score > bestMatch.score) {
                            bestMatch = {
                                score,
                                hint,
                            };
                        }
                    }
                    if (bestMatch && bestMatch.score >= 0.2) {
                        targetSubtype = bestMatch.hint.subtype;
                        bestMatch.hint.consumed = true;
                    }
                }
                if (!targetSubtype) {
                    continue;
                }

                const pdfSubtypeName = MARKUP_SUBTYPE_TO_PDF_NAME[targetSubtype];
                if (pdfSubtypeName && pdfSubtypeName !== 'Highlight') {
                    dict.set(subtypeName, PDFName.of(pdfSubtypeName));
                    rewritten = true;
                }
            }
        }

        if (!rewritten) {
            return data;
        }

        return new Uint8Array(await doc.save());
    }

    async function serializeShapeAnnotations(data: Uint8Array): Promise<Uint8Array> {
        return serializeShapeAnnotationsToDoc(data, getAllShapes());
    }

    async function rewriteFreeTextNoteRects(data: Uint8Array): Promise<Uint8Array> {
        const freetextComments = annotationComments.value.filter(
            c => c.markerRect
                && c.subtype
                && (c.subtype.toLowerCase() === 'freetext' || c.subtype.toLowerCase() === 'typewriter')
                && c.hasNote,
        );

        if (freetextComments.length === 0) {
            return data;
        }

        const doc = await loadPdfDocument(data, 'rewriting FreeText note rects');
        if (!doc) {
            return data;
        }

        const subtypeName = PDFName.of('Subtype');
        const freeTextName = PDFName.of('FreeText');
        const rectName = PDFName.of('Rect');
        const popupName = PDFName.of('Popup');
        const apName = PDFName.of('AP');
        let modified = false;

        const pages = doc.getPages();
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            const pageComments = freetextComments.filter(c => c.pageIndex === pageIndex);
            if (pageComments.length === 0) {
                continue;
            }

            const pageView = resolvePdfPageView(page);
            if (!pageView) {
                continue;
            }
            const pageRotation = normalizePageRotation(page.getRotation().angle);

            const annots = page.node.Annots();
            if (!(annots instanceof PDFArray)) {
                continue;
            }

            for (let i = 0; i < annots.size(); i++) {
                const value = annots.get(i);
                const ref = value instanceof PDFRef ? value : null;
                if (!ref) {
                    continue;
                }

                const dict = doc.context.lookupMaybe(ref, PDFDict);
                if (!dict) {
                    continue;
                }

                const currentSubtype = dict.get(subtypeName);
                if (!(currentSubtype instanceof PDFName) || currentSubtype !== freeTextName) {
                    continue;
                }

                const hasPopup = Boolean(dict.get(popupName));
                if (!hasPopup) {
                    continue;
                }

                const dictRect = toMarkerRectFromPdfRect(
                    readPdfRectFromDict(dict),
                    pageView,
                    pageRotation,
                );
                const refTag = `${ref.objectNumber}R${ref.generationNumber}`;
                const dictText = getPdfDictContents(dict).trim().toLowerCase();

                let bestMatch: {
                    comment: IAnnotationCommentSummary;
                    score: number;
                } | null = null;
                for (const comment of pageComments) {
                    if (comment.annotationId === refTag) {
                        bestMatch = {
                            comment,
                            score: 100,
                        };
                        break;
                    }

                    const iou = dictRect ? markerRectIoU(dictRect, comment.markerRect) : 0;
                    if (iou > 0.05) {
                        if (!bestMatch || iou > bestMatch.score) {
                            bestMatch = {
                                comment,
                                score: iou,
                            };
                        }
                        continue;
                    }

                    if (dictText.length > 0 && comment.text) {
                        const commentText = comment.text.trim().toLowerCase();
                        if (dictText === commentText) {
                            bestMatch = {
                                comment,
                                score: 50,
                            };
                            break;
                        }
                    }
                }

                if (!bestMatch) {
                    const singleComment = pageComments.length === 1 ? pageComments[0] : null;
                    if (singleComment) {
                        bestMatch = {
                            comment: singleComment,
                            score: 1,
                        };
                    } else {
                        continue;
                    }
                }

                const pdfRect = toPdfRectFromMarkerRect(
                    bestMatch.comment.markerRect,
                    pageView,
                    pageRotation,
                );
                if (!pdfRect) {
                    continue;
                }

                dict.set(rectName, doc.context.obj([
                    PDFNumber.of(pdfRect[0]),
                    PDFNumber.of(pdfRect[1]),
                    PDFNumber.of(pdfRect[2]),
                    PDFNumber.of(pdfRect[3]),
                ]));

                dict.delete(apName);
                modified = true;
            }
        }

        if (!modified) {
            return data;
        }

        return new Uint8Array(await doc.save());
    }

    async function updateEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary, text: string) {
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            return false;
        }

        const document = await loadPdfDocument(sourceData, 'updating embedded annotation');
        if (!document) {
            return false;
        }

        const targetRef = resolveCommentPdfRefInDocument(document, comment);
        if (!targetRef) {
            BrowserLogger.warn('annotations', 'updateEmbeddedAnnotationByRef: unable to resolve PDF annotation reference', {
                stableKey: comment.stableKey,
                source: comment.source,
                annotationId: comment.annotationId ?? null,
                id: comment.id,
                pageIndex: comment.pageIndex,
                subtype: comment.subtype ?? null,
                hasMarkerRect: Boolean(comment.markerRect),
                textLength: comment.text.trim().length,
            });
            return false;
        }

        const updated = updateAnnotationTextByRef(document, targetRef, text);
        if (!updated) {
            return false;
        }

        return new Uint8Array(await document.save());
    }

    async function deleteEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary) {
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, 'deleteEmbeddedByRef: no source data', {
                hasPdfData: Boolean(pdfData.value),
                hasWorkingCopy: Boolean(workingCopyPath.value),
            });
            return null;
        }

        const document = await loadPdfDocument(sourceData, 'deleting embedded annotation');
        if (!document) {
            return null;
        }

        const targetRef = resolveCommentPdfRefInDocument(document, comment);
        if (!targetRef) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, 'deleteEmbeddedByRef: unable to resolve ref', {
                stableKey: comment.stableKey,
                source: comment.source,
                annotationId: comment.annotationId ?? null,
                id: comment.id,
                pageIndex: comment.pageIndex,
                subtype: comment.subtype ?? null,
                textLength: comment.text?.trim().length ?? 0,
                hasMarkerRect: Boolean(comment.markerRect),
            });
            return null;
        }

        const refsToDelete = collectAnnotationRefsToDelete(document, targetRef);
        const removed = removeAnnotationRefsFromPages(document, refsToDelete);
        if (!removed) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, 'deleteEmbeddedByRef: refs not found in page annots', {
                stableKey: comment.stableKey,
                targetRef: targetRef.toString(),
                refsToDelete: refsToDelete.length,
            });
            return null;
        }

        BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'deleteEmbeddedByRef: success', {
            stableKey: comment.stableKey,
            targetRef: targetRef.toString(),
            refsDeleted: refsToDelete.length,
        });
        return new Uint8Array(await document.save());
    }

    async function rewritePageLabels(data: Uint8Array): Promise<Uint8Array> {
        if (!pageLabelsDirty.value || totalPages.value <= 0) {
            return data;
        }

        const doc = await loadPdfDocument(data, 'rewriting page labels');
        if (!doc) {
            return data;
        }

        const normalizedRanges = normalizePageLabelRanges(pageLabelRanges.value, totalPages.value);
        const pageLabelsName = PDFName.of('PageLabels');

        if (isImplicitDefaultPageLabels(normalizedRanges, totalPages.value)) {
            doc.catalog.delete(pageLabelsName);
            return new Uint8Array(await doc.save());
        }

        const nums = doc.context.obj([]);
        const styleName = PDFName.of('S');
        const prefixName = PDFName.of('P');
        const startName = PDFName.of('St');
        const typeName = PDFName.of('Type');
        const pageLabelName = PDFName.of('PageLabel');

        for (const range of normalizedRanges) {
            nums.push(PDFNumber.of(range.startPage - 1));

            const labelDict = doc.context.obj({});
            labelDict.set(typeName, pageLabelName);
            if (range.style) {
                labelDict.set(styleName, PDFName.of(range.style));
            }
            if (range.prefix.length > 0) {
                labelDict.set(prefixName, PDFHexString.fromText(range.prefix));
            }
            if (range.style && range.startNumber > 1) {
                labelDict.set(startName, PDFNumber.of(range.startNumber));
            }

            nums.push(labelDict);
        }

        const pageLabelsDict = doc.context.obj({Nums: nums});

        doc.catalog.set(pageLabelsName, pageLabelsDict);
        return new Uint8Array(await doc.save());
    }

    return {
        getSourcePdfData,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewriteFreeTextNoteRects,
        updateEmbeddedAnnotationByRef,
        deleteEmbeddedAnnotationByRef,
        rewritePageLabels,
    };
};
