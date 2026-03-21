import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    degrees,
    drawImage,
} from 'pdf-lib';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import {
    markerRectIoU,
    normalizePageRotation,
    toMarkerRectFromPdfRect,
    toPdfRectFromMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import { getPdfDictContents } from '@app/utils/pdf-dict';
import {
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
    updateAnnotationTextByRef,
} from '@app/composables/pdf/pdfSerializationComments';
import { resolveCommentPdfRefInDocument } from '@app/composables/pdf/pdfSerializationRefs';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';
import { normalizeBookmarkEntries } from '@app/composables/pdf/usePdfBookmarkSerialization';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

const RECT_NAME = PDFName.of('Rect');

export interface IPdfSerializedPlacedImagePayload extends Omit<IPdfPlacedImageFinalizePayload, 'mimeType'> {mimeType: 'image/png' | 'image/jpeg';}

export interface IPdfSerializationSavePayload {
    markupSubtypeOverrides: Array<readonly [string, TMarkupSubtype]>;
    markupSubtypeHints: IMarkupSubtypeHint[];
    shapes: IShapeAnnotation[];
    freeTextComments: IAnnotationCommentSummary[];
    annotationComments: IAnnotationCommentSummary[];
    pendingEmbeddedTextUpdates: Array<readonly [string, string]>;
    pageLabelsDirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    totalPages: number;
    bookmarksDirty: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
    placedImage: IPdfSerializedPlacedImagePayload | null;
}

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

function appendAnnotationRefToPage(
    page: ReturnType<PDFDocument['getPages']>[number],
    doc: PDFDocument,
    annotRef: PDFRef,
) {
    const annots = page.node.Annots() ?? doc.context.obj([]);
    if (annots instanceof PDFArray) {
        annots.push(annotRef);
        page.node.set(PDFName.of('Annots'), annots);
        return;
    }

    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
}

function isAnnotationMarkerRect(value: IAnnotationCommentSummary['markerRect']): value is IAnnotationMarkerRect {
    return Boolean(
        value
        && Number.isFinite(value.left)
        && Number.isFinite(value.top)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height),
    );
}

function createRectAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    subtype: 'Square' | 'Circle',
    pageWidth: number,
    pageHeight: number,
): PDFDict {
    const x = shape.x * pageWidth;
    const y = (1 - shape.y - shape.height) * pageHeight;
    const width = shape.width * pageWidth;
    const height = shape.height * pageHeight;
    const rect = doc.context.obj([
        x,
        y,
        x + width,
        y + height,
    ]);
    const red = Number.parseInt(shape.color.slice(1, 3), 16) / 255;
    const green = Number.parseInt(shape.color.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(shape.color.slice(5, 7), 16) / 255;

    return doc.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: rect,
        C: [
            red,
            green,
            blue,
        ],
        CA: shape.opacity,
        Border: [
            0,
            0,
            shape.strokeWidth,
        ],
    });
}

function setInteriorColor(annotDict: PDFDict, doc: PDFDocument, fillColor: string | undefined) {
    if (!fillColor) {
        return;
    }

    const red = Number.parseInt(fillColor.slice(1, 3), 16) / 255;
    const green = Number.parseInt(fillColor.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(fillColor.slice(5, 7), 16) / 255;
    annotDict.set(PDFName.of('IC'), doc.context.obj([
        red,
        green,
        blue,
    ]));
}

function createLineAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageWidth: number,
    pageHeight: number,
): PDFDict {
    const x1 = shape.x * pageWidth;
    const y1 = (1 - shape.y) * pageHeight;
    const x2 = (shape.x2 ?? shape.x) * pageWidth;
    const y2 = (1 - (shape.y2 ?? shape.y)) * pageHeight;
    const lineWidth = shape.strokeWidth;

    const minX = Math.min(x1, x2) - lineWidth;
    const minY = Math.min(y1, y2) - lineWidth;
    const maxX = Math.max(x1, x2) + lineWidth;
    const maxY = Math.max(y1, y2) + lineWidth;
    const red = Number.parseInt(shape.color.slice(1, 3), 16) / 255;
    const green = Number.parseInt(shape.color.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(shape.color.slice(5, 7), 16) / 255;

    const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Line',
        Rect: doc.context.obj([
            minX,
            minY,
            maxX,
            maxY,
        ]),
        L: doc.context.obj([
            x1,
            y1,
            x2,
            y2,
        ]),
        C: [
            red,
            green,
            blue,
        ],
        CA: shape.opacity,
        Border: [
            0,
            0,
            lineWidth,
        ],
    });

    if (shape.type === 'arrow') {
        annotDict.set(PDFName.of('LE'), doc.context.obj([
            PDFName.of('None'),
            PDFName.of(shape.lineEndStyle === 'openArrow' ? 'OpenArrow' : 'ClosedArrow'),
        ]));
    }

    return annotDict;
}

function applyShapeAnnotations(doc: PDFDocument, shapes: IShapeAnnotation[]) {
    if (shapes.length === 0) {
        return false;
    }

    const pages = doc.getPages();
    let modified = false;

    for (const shape of shapes) {
        const page = pages[shape.pageIndex];
        if (!page) {
            continue;
        }

        const {
            width: pageWidth,
            height: pageHeight,
        } = page.getSize();

        let annotDict: PDFDict | null = null;
        if (shape.type === 'rectangle') {
            annotDict = createRectAnnotationDict(doc, shape, 'Square', pageWidth, pageHeight);
            setInteriorColor(annotDict, doc, shape.fillColor);
        } else if (shape.type === 'circle') {
            annotDict = createRectAnnotationDict(doc, shape, 'Circle', pageWidth, pageHeight);
            setInteriorColor(annotDict, doc, shape.fillColor);
        } else if (shape.type === 'line' || shape.type === 'arrow') {
            annotDict = createLineAnnotationDict(doc, shape, pageWidth, pageHeight);
        }

        if (!annotDict) {
            continue;
        }

        const annotRef = doc.context.register(annotDict);
        appendAnnotationRefToPage(page, doc, annotRef);
        modified = true;
    }

    return modified;
}

function applyMarkupSubtypeRewrites(
    doc: PDFDocument,
    overrides: Array<readonly [string, TMarkupSubtype]>,
    subtypeHints: IMarkupSubtypeHint[],
) {
    const overridesMap = new Map<string, TMarkupSubtype>(overrides);
    if (overridesMap.size === 0 && subtypeHints.length === 0) {
        return false;
    }

    const hintsByPage = new Map<number, IMarkupSubtypeHint[]>();
    subtypeHints.forEach((hint) => {
        const pageHints = hintsByPage.get(hint.pageIndex);
        if (pageHints) {
            pageHints.push({
                ...hint,
                consumed: false,
            });
            return;
        }
        hintsByPage.set(hint.pageIndex, [{
            ...hint,
            consumed: false,
        }]);
    });

    const subtypeName = PDFName.of('Subtype');
    const highlightName = PDFName.of('Highlight');
    let rewritten = false;

    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const pageHints = hintsByPage.get(pageIndex) ?? [];
        const pageView = resolvePdfPageView(page);
        if (!pageView) {
            continue;
        }
        const pageRotation = normalizePageRotation(page.getRotation().angle);
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const value = annots.get(index);
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
            let targetSubtype = overridesMap.get(refTag) ?? null;
            if (!targetSubtype && pageHints.length > 0) {
                const markerRect = toMarkerRectFromPdfRect(
                    readPdfRectFromDict(dict),
                    pageView,
                    pageRotation,
                );
                let bestMatch: {
                    score: number;
                    hint: IMarkupSubtypeHint;
                } | null = null;

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

    return rewritten;
}

function applyFreeTextNoteRects(doc: PDFDocument, comments: IAnnotationCommentSummary[]) {
    if (comments.length === 0) {
        return false;
    }

    const subtypeName = PDFName.of('Subtype');
    const freeTextName = PDFName.of('FreeText');
    const rectName = PDFName.of('Rect');
    const popupName = PDFName.of('Popup');
    const apName = PDFName.of('AP');
    let modified = false;
    let blankApRef: PDFRef | null = null;

    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const pageComments = comments.filter(comment => comment.pageIndex === pageIndex && isAnnotationMarkerRect(comment.markerRect));
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

        for (let annotIndex = 0; annotIndex < annots.size(); annotIndex += 1) {
            const value = annots.get(annotIndex);
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

            if (!dict.get(popupName)) {
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
                if (!isAnnotationMarkerRect(comment.markerRect)) {
                    continue;
                }

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
                if (!singleComment || !isAnnotationMarkerRect(singleComment.markerRect)) {
                    continue;
                }
                bestMatch = {
                    comment: singleComment,
                    score: 1,
                };
            }

            if (!isAnnotationMarkerRect(bestMatch.comment.markerRect)) {
                continue;
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

            if (!blankApRef) {
                blankApRef = doc.context.register(doc.context.formXObject([], {}));
            }
            dict.set(apName, doc.context.obj({ N: blankApRef }));
            modified = true;
        }
    }

    return modified;
}

function applyEmbeddedNoteTextUpdates(
    doc: PDFDocument,
    comments: IAnnotationCommentSummary[],
    pendingUpdates: Array<readonly [string, string]>,
) {
    if (pendingUpdates.length === 0) {
        return false;
    }

    const commentsByKey = new Map<string, IAnnotationCommentSummary>();
    comments.forEach((comment) => {
        const match = pendingUpdates.some(([stableKey]) => stableKey === comment.stableKey);
        if (match) {
            commentsByKey.set(comment.stableKey, comment);
        }
    });

    let modified = false;
    for (const [
        stableKey,
        text,
    ] of pendingUpdates) {
        const comment = commentsByKey.get(stableKey);
        if (!comment) {
            continue;
        }

        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            continue;
        }

        if (updateAnnotationTextByRef(doc, targetRef, text)) {
            modified = true;
        }
    }

    return modified;
}

function applyPageLabels(
    doc: PDFDocument,
    pageLabelsDirty: boolean,
    pageLabelRanges: IPdfPageLabelRange[],
    totalPages: number,
) {
    if (!pageLabelsDirty || totalPages <= 0) {
        return false;
    }

    const normalizedRanges = normalizePageLabelRanges(pageLabelRanges, totalPages);
    const pageLabelsName = PDFName.of('PageLabels');

    if (isImplicitDefaultPageLabels(normalizedRanges, totalPages)) {
        const hadLabels = doc.catalog.has(pageLabelsName);
        doc.catalog.delete(pageLabelsName);
        return hadLabels;
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

    doc.catalog.set(pageLabelsName, doc.context.obj({Nums: nums}));
    return true;
}

function applyBookmarks(
    doc: PDFDocument,
    bookmarksDirty: boolean,
    bookmarkItems: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
) {
    if (!bookmarksDirty) {
        return false;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(bookmarkItems, totalPages, untitledLabel);
    const outlinesName = PDFName.of('Outlines');
    if (normalizedBookmarks.length === 0) {
        const hadOutlines = doc.catalog.has(outlinesName);
        doc.catalog.delete(outlinesName);
        return hadOutlines;
    }

    interface IOutlineNodeBuild {
        ref: PDFRef;
        dict: PDFDict;
        item: IPdfBookmarkEntry;
        visibleCount: number;
    }

    const parentName = PDFName.of('Parent');
    const prevName = PDFName.of('Prev');
    const nextName = PDFName.of('Next');
    const firstName = PDFName.of('First');
    const lastName = PDFName.of('Last');
    const countName = PDFName.of('Count');
    const titleName = PDFName.of('Title');
    const destName = PDFName.of('Dest');
    const typeName = PDFName.of('Type');
    const flagsName = PDFName.of('F');
    const colorName = PDFName.of('C');
    const pdfNull = doc.context.obj(null);

    function setNodeDestination(dict: PDFDict, item: IPdfBookmarkEntry) {
        if (typeof item.pageIndex === 'number') {
            const pageRef = doc.getPage(item.pageIndex).ref;
            dict.set(destName, doc.context.obj([
                pageRef,
                PDFName.of('XYZ'),
                pdfNull,
                pdfNull,
                pdfNull,
            ]));
            return;
        }

        if (item.namedDest) {
            dict.set(destName, PDFString.of(item.namedDest));
        }
    }

    function setNodeStyle(dict: PDFDict, item: IPdfBookmarkEntry) {
        const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
        if (flags > 0) {
            dict.set(flagsName, PDFNumber.of(flags));
        }

        if (!item.color) {
            return;
        }

        const value = item.color.replace('#', '');
        const red = Number.parseInt(value.slice(0, 2), 16) / 255;
        const green = Number.parseInt(value.slice(2, 4), 16) / 255;
        const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
        dict.set(colorName, doc.context.obj([
            red,
            green,
            blue,
        ]));
    }

    function buildOutlineLevel(items: IPdfBookmarkEntry[], parentRef: PDFRef) {
        if (items.length === 0) {
            return {
                first: null as PDFRef | null,
                last: null as PDFRef | null,
                visibleCount: 0,
            };
        }

        const nodes: IOutlineNodeBuild[] = items.map((item) => {
            const dict = doc.context.obj({});
            dict.set(titleName, PDFHexString.fromText(item.title));
            setNodeDestination(dict, item);
            setNodeStyle(dict, item);
            const ref = doc.context.register(dict);
            return {
                ref,
                dict,
                item,
                visibleCount: 1,
            };
        });

        nodes.forEach((node, index) => {
            node.dict.set(parentName, parentRef);
            const previous = nodes[index - 1];
            if (previous) {
                node.dict.set(prevName, previous.ref);
            }
            const next = nodes[index + 1];
            if (next) {
                node.dict.set(nextName, next.ref);
            }
        });

        for (const node of nodes) {
            const childResult = buildOutlineLevel(node.item.items, node.ref);
            if (childResult.first && childResult.last) {
                node.dict.set(firstName, childResult.first);
                node.dict.set(lastName, childResult.last);
                if (childResult.visibleCount > 0) {
                    node.dict.set(countName, PDFNumber.of(childResult.visibleCount));
                }
                node.visibleCount += childResult.visibleCount;
            }
        }

        return {
            first: nodes[0]?.ref ?? null,
            last: nodes[nodes.length - 1]?.ref ?? null,
            visibleCount: nodes.reduce((total, node) => total + node.visibleCount, 0),
        };
    }

    const outlinesDict = doc.context.obj({});
    outlinesDict.set(typeName, PDFName.of('Outlines'));
    const outlinesRef = doc.context.register(outlinesDict);
    const tree = buildOutlineLevel(normalizedBookmarks, outlinesRef);
    if (!tree.first || !tree.last) {
        doc.catalog.delete(outlinesName);
        return true;
    }

    outlinesDict.set(firstName, tree.first);
    outlinesDict.set(lastName, tree.last);
    outlinesDict.set(countName, PDFNumber.of(tree.visibleCount));
    doc.catalog.set(outlinesName, outlinesRef);
    return true;
}

async function applyPlacedImage(
    doc: PDFDocument,
    placement: IPdfSerializedPlacedImagePayload | null,
) {
    if (!placement || placement.bytes.length === 0) {
        return false;
    }

    const page = doc.getPages()[placement.pageNumber - 1];
    if (!page) {
        return false;
    }

    const pageView = resolvePdfPageView(page);
    if (!pageView) {
        return false;
    }

    const embedMimeType = placement.mimeType;
    const embeddedImage = embedMimeType === 'image/jpeg'
        ? await doc.embedJpg(placement.bytes)
        : await doc.embedPng(placement.bytes);

    const pageRotation = normalizePageRotation(page.getRotation().angle);
    const pdfRect = toPdfRectFromMarkerRect({
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
    }, pageView, pageRotation);
    if (!pdfRect) {
        return false;
    }

    const x = Math.min(pdfRect[0], pdfRect[2]);
    const y = Math.min(pdfRect[1], pdfRect[3]);
    const width = Math.abs(pdfRect[2] - pdfRect[0]);
    const height = Math.abs(pdfRect[3] - pdfRect[1]);
    if (width <= 0 || height <= 0) {
        return false;
    }

    const rotationDegrees = 0 - (placement.rotationDegrees ?? 0);
    const radians = (rotationDegrees * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    const bboxWidth = (width * absCos) + (height * absSin);
    const bboxHeight = (width * absSin) + (height * absCos);
    const bboxCenterX = bboxWidth / 2;
    const bboxCenterY = bboxHeight / 2;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotatedHalfWidth = ((width / 2) * cos) - ((height / 2) * sin);
    const rotatedHalfHeight = ((width / 2) * sin) + ((height / 2) * cos);
    const imageX = bboxCenterX - rotatedHalfWidth;
    const imageY = bboxCenterY - rotatedHalfHeight;
    const imageName = doc.context.addRandomSuffix('Image', 10);
    const appearanceRef = doc.context.register(
        doc.context.formXObject(
            drawImage(imageName, {
                x: imageX,
                y: imageY,
                width,
                height,
                rotate: degrees(rotationDegrees),
                xSkew: degrees(0),
                ySkew: degrees(0),
            }),
            {
                Resources: { XObject: { [imageName]: embeddedImage.ref } },
                BBox: doc.context.obj([
                    0,
                    0,
                    bboxWidth,
                    bboxHeight,
                ]),
                Matrix: doc.context.obj([
                    1,
                    0,
                    0,
                    1,
                    0,
                    0,
                ]),
            },
        ),
    );
    const rectOffsetX = (bboxWidth - width) / 2;
    const rectOffsetY = (bboxHeight - height) / 2;
    const stampDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: doc.context.obj([
            PDFNumber.of(x - rectOffsetX),
            PDFNumber.of(y - rectOffsetY),
            PDFNumber.of(x + width + rectOffsetX),
            PDFNumber.of(y + height + rectOffsetY),
        ]),
        AP: doc.context.obj({ N: appearanceRef }),
        F: PDFNumber.of(4),
        NM: PDFHexString.fromText(`placed-image-${crypto.randomUUID()}`),
        Name: PDFName.of('Approved'),
    });
    appendAnnotationRefToPage(page, doc, doc.context.register(stampDict));
    return true;
}

function hasSaveWork(payload: IPdfSerializationSavePayload) {
    return payload.markupSubtypeOverrides.length > 0
        || payload.markupSubtypeHints.length > 0
        || payload.shapes.length > 0
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
    modified = applyShapeAnnotations(doc, payload.shapes) || modified;
    modified = applyFreeTextNoteRects(doc, payload.freeTextComments) || modified;
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
