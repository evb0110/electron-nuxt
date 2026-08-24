import {
    degrees,
    PDFArray,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFString,
    StandardFonts,
} from 'pdf-lib';
import type { PDFRef } from 'pdf-lib';
import {
    DOMMatrix,
    ImageData,
    Path2D,
} from '@napi-rs/canvas';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    ILinkAnnotation,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { collectPagePdfSnapshotEntries } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPagePdfSnapshotEntries';
import { loadPdfPageAnnotations } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/loadPdfPageAnnotations';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import { cast } from '@tests/helpers/cast';

/**
 * A page-level stand-in for the reported book: real text, a real PDF.js load, a
 * real PDF.js highlight materialization, and real staged bytes. Nothing here
 * embeds the reported document; the geometry that matters is the selection box
 * list, and that is supplied per test.
 */

export interface ISelectionBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** A Highlight the file already carries, as an incrementally saved book has. */
export interface IExistingHighlight {
    /** One eight-number quad per highlighted line. */
    readonly quads: ReadonlyArray<readonly number[]>;
    readonly contents?: string;
    /**
     * Note text reachable only through the linked popup. The markup's own
     * `/Contents` stays empty and its `/Popup` points at a popup parented to a
     * different annotation, which is how a producer that reuses one popup for
     * a reply chain leaves a file: the note is what the reader shows, but it is
     * not in the markup's own dictionary.
     */
    readonly popupNoteText?: string;
}

export interface IFixtureOptions {
    readonly rotate?: 0 | 90 | 180 | 270;
    readonly existingHighlights?: readonly IExistingHighlight[];
}

const FIXTURE_PAGE_WIDTH = 612;
const FIXTURE_PAGE_HEIGHT = 792;

/** Deliberately not the reported sentence; no document text is asserted on. */
const FIXTURE_LINE = 'The quick brown fox jumps over the lazy dog again.';

function boundingRectOfQuads(quads: ReadonlyArray<readonly number[]>) {
    const xs = quads.flatMap(quad => quad.filter((_value, index) => index % 2 === 0));
    const ys = quads.flatMap(quad => quad.filter((_value, index) => index % 2 === 1));
    return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
    ];
}

function appendPageAnnotation(document: PDFDocument, pageIndex: number, ref: PDFRef) {
    const page = document.getPages()[pageIndex]!;
    const annots = page.node.Annots();
    if (annots) {
        annots.push(ref);
        return;
    }
    page.node.set(PDFName.of('Annots'), document.context.obj([ref]));
}

function addExistingHighlight(document: PDFDocument, highlight: IExistingHighlight) {
    const rect = boundingRectOfQuads(highlight.quads);
    const highlightRef = document.context.nextRef();
    const noteHolderRef = highlight.popupNoteText
        ? document.context.register(document.context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Rect: rect,
            Contents: PDFString.of(highlight.popupNoteText),
        }))
        : null;
    const popupRef = noteHolderRef
        ? document.context.register(document.context.obj({
            Type: 'Annot',
            Subtype: 'Popup',
            Rect: rect,
            Parent: noteHolderRef,
        }))
        : null;
    document.context.assign(highlightRef, document.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: rect,
        QuadPoints: highlight.quads.flatMap(quad => [...quad]),
        C: [
            1,
            0.8,
            0,
        ],
        CA: 0.4,
        F: 4,
        ...(highlight.contents ? {Contents: PDFString.of(highlight.contents)} : {}),
        ...(popupRef ? {Popup: popupRef} : {}),
    }));
    [
        highlightRef,
        noteHolderRef,
        popupRef,
    ].forEach((ref) => {
        if (ref) {
            appendPageAnnotation(document, 0, ref);
        }
    });
}

export async function createHighlightFixturePdf(options: IFixtureOptions = {}) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        FIXTURE_PAGE_WIDTH,
        FIXTURE_PAGE_HEIGHT,
    ]);
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    for (let line = 0; line < 6; line += 1) {
        page.drawText(FIXTURE_LINE, {
            x: 72,
            y: 700 - line * 16,
            size: 11,
            font,
        });
    }
    if (options.rotate) {
        page.setRotation(degrees(options.rotate));
    }
    options.existingHighlights?.forEach((highlight) => {
        addExistingHighlight(doc, highlight);
    });
    return doc.save();
}

export function toSelectionMarkerRects(boxes: readonly ISelectionBox[]): IAnnotationMarkerRect[] {
    return boxes.map(box => ({
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
    }));
}

/**
 * PDF.js's legacy build reads these off `globalThis`, and Node carries none of
 * them, so a harness load has to install them. Leaving them installed would
 * leak this file's canvas shims into every later suite in the same worker, so
 * each prior binding is recorded first — including the common case of "there
 * was no such property" — and {@link restorePdfjsCanvasGlobals} puts the scope
 * back exactly as it was found.
 */
const PDFJS_CANVAS_GLOBALS = Object.freeze([
    [
        'DOMMatrix',
        DOMMatrix,
    ],
    [
        'ImageData',
        ImageData,
    ],
    [
        'Path2D',
        Path2D,
    ],
] as const);

interface IPriorGlobalBinding {
    readonly key: string;
    readonly present: boolean;
    readonly value: unknown;
}

let priorCanvasGlobals: IPriorGlobalBinding[] | null = null;

function installPdfjsCanvasGlobals() {
    if (priorCanvasGlobals) {
        return;
    }
    priorCanvasGlobals = PDFJS_CANVAS_GLOBALS.map(([
        key,
        value,
    ]) => {
        const present = Object.hasOwn(globalThis, key);
        const prior = present ? cast<unknown>(Reflect.get(globalThis, key)) : undefined;
        Reflect.set(globalThis, key, value);
        return {
            key,
            present,
            value: prior,
        };
    });
}

/**
 * Undoes {@link installPdfjsCanvasGlobals}. Suites that touch this harness call
 * it in `afterAll`; calling it without a prior install, or twice, is a no-op.
 */
export function restorePdfjsCanvasGlobals() {
    if (!priorCanvasGlobals) {
        return;
    }
    priorCanvasGlobals.forEach((binding) => {
        if (binding.present) {
            Reflect.set(globalThis, binding.key, binding.value);
            return;
        }
        Reflect.deleteProperty(globalThis, binding.key);
    });
    priorCanvasGlobals = null;
}

async function loadWithPdfjs(bytes: Uint8Array) {
    installPdfjsCanvasGlobals();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return pdfjs.getDocument(cast<Parameters<typeof pdfjs.getDocument>[0]>({
        data: bytes.slice(),
        disableWorker: true,
        useSystemFonts: true,
    })).promise;
}

/**
 * Loads `bytes`, hands the document to `use`, and destroys it however `use`
 * ends. A PDF.js document owns a worker port and a transport; a harness that
 * leaks one on a failing assertion leaves the worker alive for the rest of the
 * run and turns one failure into a hang.
 */
export async function withPdfjsDocument<T>(
    bytes: Uint8Array,
    use: (document: Awaited<ReturnType<typeof loadWithPdfjs>>) => Promise<T>,
): Promise<T> {
    const document = await loadWithPdfjs(bytes);
    try {
        return await use(document);
    } finally {
        await document.destroy();
    }
}

/**
 * The production read path for annotations a file already carries: the same
 * page bundle, the same summary projection, the same canonical ingest the
 * viewer runs when it opens a document. Tests bind to it rather than to
 * hand-written summaries so ingest and save verification cannot drift apart
 * without a test noticing.
 */
export async function ingestFixtureAnnotations(
    application: AnnotationApplication,
    bytes: Uint8Array,
) {
    return withPdfjsDocument(bytes, async (document) => {
        const bundle = await loadPdfPageAnnotations(cast<PDFDocumentProxy>(document), 1);
        if (!bundle) {
            throw new Error('The fixture page produced no annotation bundle');
        }
        const comments: IAnnotationCommentSummary[] = [];
        const links: ILinkAnnotation[] = [];
        collectPagePdfSnapshotEntries(
            bundle,
            1,
            {
                computeStableKey: computeSummaryStableKey,
                resolveKindLabel: subtype => subtype ?? '',
            },
            comments,
            links,
        );
        application.ingestLegacySummaries(comments);
        return comments;
    });
}

export type TQuadCornerOrder = 'pdfjs' | 'spec-reversed';

/**
 * Mirrors `HighlightEditor.#serializeBoxes`
 * (`node_modules/pdfjs-dist/legacy/build/pdf.mjs`, `#serializeBoxes`): selection
 * boxes are page-normalized with a top-left origin, and each becomes one quad
 * written top-left, top-right, bottom-left, bottom-right.
 */
function serializeSelectionBoxes(
    boxes: readonly ISelectionBox[],
    rawDims: {
        pageWidth: number;
        pageHeight: number;
        pageX: number;
        pageY: number
    },
    cornerOrder: TQuadCornerOrder,
) {
    const quadPoints = new Float32Array(boxes.length * 8);
    let index = 0;
    for (const box of boxes) {
        const sx = box.x * rawDims.pageWidth + rawDims.pageX;
        const sy = (1 - box.y) * rawDims.pageHeight + rawDims.pageY;
        const right = sx + box.width * rawDims.pageWidth;
        const bottom = sy - box.height * rawDims.pageHeight;
        const corners = cornerOrder === 'pdfjs'
            ? [
                sx,
                sy,
                right,
                sy,
                sx,
                bottom,
                right,
                bottom,
            ]
            : [
                right,
                bottom,
                sx,
                bottom,
                right,
                sy,
                sx,
                sy,
            ];
        corners.forEach((value, offset) => {
            quadPoints[index + offset] = value;
        });
        index += 8;
    }
    return quadPoints;
}

export interface IStageHighlightOptions {
    readonly boxes: readonly ISelectionBox[];
    readonly cornerOrder?: TQuadCornerOrder;
    /** Reverses the order quads are written in, which the format leaves free. */
    readonly reverseQuadOrder?: boolean;
    readonly color?: readonly [number, number, number];
    readonly opacity?: number;
}

export interface IStagedHighlight {
    readonly bytes: Uint8Array;
    readonly pdfRef: string;
    readonly quadCount: number;
    readonly contents: string;
}

/**
 * Runs the production materialization: the editor's serialized highlight goes
 * into PDF.js's annotation storage and `saveDocument()` writes the staged bytes.
 */
export async function stageHighlightSave(
    fixture: Uint8Array,
    options: IStageHighlightOptions,
): Promise<IStagedHighlight> {
    const staged = await withPdfjsDocument(fixture, async (document) => {
        const page = await document.getPage(1);
        const rawDims = cast<{
            pageWidth: number;
            pageHeight: number;
            pageX: number;
            pageY: number;
        }>(page.getViewport({ scale: 1 }).rawDims);
        const preexisting = new Set((await page.getAnnotations()).map(record => String(record.id)));
        const boxes = options.reverseQuadOrder ? [...options.boxes].reverse() : options.boxes;
        const quadPoints = serializeSelectionBoxes(boxes, rawDims, options.cornerOrder ?? 'pdfjs');
        const xs = Array.from(quadPoints).filter((_value, position) => position % 2 === 0);
        const ys = Array.from(quadPoints).filter((_value, position) => position % 2 === 1);
        const outlines: number[][] = [];
        for (let cursor = 0; cursor < quadPoints.length; cursor += 8) {
            outlines.push([
                quadPoints[cursor]!,
                quadPoints[cursor + 1]!,
                quadPoints[cursor + 2]!,
                quadPoints[cursor + 3]!,
                quadPoints[cursor + 6]!,
                quadPoints[cursor + 7]!,
                quadPoints[cursor + 4]!,
                quadPoints[cursor + 5]!,
            ]);
        }
        document.annotationStorage.setValue('pdfjs_internal_editor_0', cast<never>({
            annotationType: 9,
            color: options.color ?? [
                255,
                204,
                0,
            ],
            opacity: options.opacity ?? 0.4,
            thickness: 12,
            quadPoints,
            outlines,
            pageIndex: 0,
            rect: [
                Math.min(...xs),
                Math.min(...ys),
                Math.max(...xs),
                Math.max(...ys),
            ],
            rotation: 0,
            structTreeParentId: null,
            popupRef: '',
        }));
        return {
            bytes: await document.saveDocument(),
            preexisting,
        };
    });
    const {
        bytes,
        preexisting,
    } = staged;
    const created = await readStagedHighlight(bytes, preexisting);
    return {
        bytes,
        ...created,
    };
}

async function readStagedHighlight(bytes: Uint8Array, preexisting: ReadonlySet<string>) {
    return withPdfjsDocument(bytes, async (document) => {
        const page = await document.getPage(1);
        const record = (await page.getAnnotations())
            .find(candidate => !preexisting.has(String(candidate.id)));
        if (!record) {
            throw new Error('The staged PDF has no newly materialized annotation');
        }
        return {
            pdfRef: String(record.id),
            quadCount: record.quadPoints ? record.quadPoints.length / 8 : 0,
            contents: String(record.contentsObj?.str ?? record.contents ?? ''),
        };
    });
}

export async function readPreexistingAnnotationIds(bytes: Uint8Array) {
    return withPdfjsDocument(bytes, async (document) => {
        const page = await document.getPage(1);
        return new Set((await page.getAnnotations()).map(record => String(record.id)));
    });
}

/**
 * Rewrites the staged annotation in place so a test can stage bytes that are
 * genuinely wrong: a moved rectangle, a different subtype, unexpected
 * `/Contents`. Object numbers survive, so the recorded PDF ref still resolves.
 *
 * With no mutation this is still a real writer round trip — every object is
 * re-serialized, coordinates included — which is what a staged save does to an
 * annotation the user only restyled.
 */
export async function mutateStagedHighlight(
    bytes: Uint8Array,
    pdfRef: string,
    mutate: (context: {
        setSubtype(value: string): void;
        setContents(value: string): void;
        setQuadPoints(values: readonly number[]): void;
        quadPoints(): number[];
    }) => void = () => undefined,
) {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const objectNumber = Number.parseInt(pdfRef.replace(/R\d*$/u, ''), 10);
    const page = document.getPages()[0]!;
    const annots = page.node.Annots();
    const dict = annots
        ? Array.from({ length: annots.size() }, (_unused, index) => annots.get(index))
            .map(ref => ({
                ref,
                dict: page.node.context.lookup(ref),
            }))
            .find(entry => cast<{objectNumber?: number}>(entry.ref).objectNumber === objectNumber)?.dict
        : null;
    if (!dict || !('set' in cast<Record<string, unknown>>(dict))) {
        throw new Error(`Staged annotation ${pdfRef} is not reachable for mutation`);
    }
    const annotationDict = cast<{
        set(key: PDFName, value: unknown): void;
        lookup(key: PDFName): unknown;
    }>(dict);
    mutate({
        setSubtype: (value: string) => annotationDict.set(PDFName.of('Subtype'), PDFName.of(value)),
        setContents: (value: string) => annotationDict.set(PDFName.of('Contents'), PDFString.of(value)),
        setQuadPoints: (values: readonly number[]) => annotationDict.set(
            PDFName.of('QuadPoints'),
            document.context.obj(values.map(value => PDFNumber.of(value))),
        ),
        quadPoints: () => {
            const array = annotationDict.lookup(PDFName.of('QuadPoints'));
            return array instanceof PDFArray
                ? array.asArray().map(value => (value instanceof PDFNumber ? value.asNumber() : Number.NaN))
                : [];
        },
    });
    return document.save({ useObjectStreams: false });
}
