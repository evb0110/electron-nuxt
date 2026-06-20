import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { sortBy } from 'es-toolkit/array';
import {
    decodePDFRawStream,
    PDFContentStream,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
    type PDFPage,
} from 'pdf-lib';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import { abortErrorFromSignal } from '@electron/utils/abort';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const TESSERACT_IMAGE_PAINT_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+\/Im\d+\s+Do\s+Q\r?\n/gm;
const TESSERACT_IMAGE_XOBJECT_RE = /\n\s*\/XObject\s*<<\s*\n(?:\s*\/Im\d+\s+\d+\s+\d+\s+R\s*\n)+\s*>>/g;
const OCR_LAYER_MARKER = 'EVB_VIEWER_OCR_LAYER';
const MAX_OCR_OUTPUT_ABSOLUTE_GROWTH_BYTES = 100 * 1024 * 1024;
const MAX_OCR_OUTPUT_GROWTH_MULTIPLIER = 4;
const INVISIBLE_TEXT_RENDERING_RE = /(?:^|\s)3(?:\.0+)?\s+Tr\b/;
const IMAGE_OR_FORM_DRAW_TEST_RE = /\/[A-Za-z0-9._-]+\s+Do\b/;
const IMAGE_OR_FORM_DRAW_RE = /\/([A-Za-z0-9._-]+)\s+Do\b/g;
const FONT_DRAW_RE = /\/([A-Za-z0-9._-]+)\s+[-+0-9.]+\s+Tf\b/g;
const TESSERACT_HIDDEN_TEXT_OBJECT_RE = /BT[\s\S]*?(?:^|\s)3(?:\.0+)?\s+Tr\b[\s\S]*?ET\s*/gm;
const TESSERACT_EMPTY_TEXT_ONLY_PREAMBLE_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+Q\s*$/;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function assertNonEmptyFile(path: string, label: string) {
    const fileStat = await stat(path);
    if (fileStat.size <= 0) {
        throw new Error(`${label} is empty: ${path}`);
    }
}

async function assertReasonableOcrOutputSize(inputPath: string, outputPath: string) {
    const [
        inputStat,
        outputStat,
    ] = await Promise.all([
        stat(inputPath),
        stat(outputPath),
    ]);
    const maxAllowedSize = Math.max(
        inputStat.size * MAX_OCR_OUTPUT_GROWTH_MULTIPLIER,
        inputStat.size + MAX_OCR_OUTPUT_ABSOLUTE_GROWTH_BYTES,
    );
    if (outputStat.size > maxAllowedSize) {
        throw new Error(
            `Assembled OCR PDF is unexpectedly large (${outputStat.size} bytes from ${inputStat.size} bytes)`,
        );
    }
}

export async function getPageCount(
    qpdfBinary: string,
    pdfPath: string,
    fallback: number,
    signal?: AbortSignal,
) {
    try {
        const commandOptions: TOcrRunCommandOptions = {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(show-npages)',
        };
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        const result = await runOcrCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], commandOptions);
        const parsed = parseInt((result.stdout ?? '').trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    } catch {
        // Use fallback
    }
    return fallback;
}

function buildValidOcrPageEntries(ocrPdfMap: Map<number, string>, pageCount: number) {
    return sortBy(
        Array.from(ocrPdfMap.entries())
            .filter(([pageNumber]) => pageNumber >= 1 && pageNumber <= pageCount),
        [([pageNumber]) => pageNumber],
    );
}

export function stripTesseractImageLayer(qdfSource: string) {
    const withoutImagePaint = qdfSource.replace(TESSERACT_IMAGE_PAINT_RE, '');
    return withoutImagePaint.replace(TESSERACT_IMAGE_XOBJECT_RE, '');
}

function decodeContentStream(stream: PDFStream) {
    if (stream instanceof PDFRawStream) {
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    if (stream instanceof PDFContentStream) {
        return Buffer.from(stream.getUnencodedContents()).toString('latin1');
    }
    return '';
}

function collectResourceNames(source: string, pattern: RegExp) {
    const names = new Set<string>();
    for (const match of source.matchAll(pattern)) {
        const name = match[1];
        if (name) {
            names.add(name);
        }
    }
    return names;
}

function deleteUnreferencedEntries(dict: PDFDict, referencedNames: Set<string>) {
    for (const key of dict.keys()) {
        const name = key.toString().replace(/^\//, '');
        if (!referencedNames.has(name)) {
            dict.delete(key);
        }
    }
}

function cloneMutablePageResources(page: PDFPage) {
    page.node.normalize();
    const context = page.doc.context;
    const resources = page.node.Resources()?.clone(context) ?? context.obj({});
    const font = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (font) {
        resources.set(PDFName.of('Font'), font.clone(context));
    }
    const xObject = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xObject) {
        resources.set(PDFName.of('XObject'), xObject.clone(context));
    }
    page.node.set(PDFName.of('Resources'), resources);
}

function isTextOnlyOcrStream(streamText: string, strippedText: string) {
    if (IMAGE_OR_FORM_DRAW_TEST_RE.test(streamText)) {
        return false;
    }
    return strippedText.trim().replace(TESSERACT_EMPTY_TEXT_ONLY_PREAMBLE_RE, '').trim() === '';
}

function removePreviousOcrLayer(page: PDFPage) {
    cloneMutablePageResources(page);
    const context = page.doc.context;
    const {
        Contents,
        Font,
        XObject,
    } = page.node.normalizedEntries();
    if (!Contents) {
        return;
    }

    const keptContentText: string[] = [];
    for (let index = Contents.size() - 1; index >= 0; index -= 1) {
        const contentRef = Contents.get(index);
        const contentStream = Contents.lookup(index, PDFStream);
        const streamText = decodeContentStream(contentStream);

        if (streamText.includes(OCR_LAYER_MARKER)) {
            const markedXObjects = collectResourceNames(streamText, IMAGE_OR_FORM_DRAW_RE);
            Contents.remove(index);
            if (contentRef instanceof PDFRef) {
                context.delete(contentRef);
            }
            for (const name of markedXObjects) {
                XObject.delete(PDFName.of(name));
            }
            continue;
        }

        if (!INVISIBLE_TEXT_RENDERING_RE.test(streamText)) {
            keptContentText.push(streamText);
            continue;
        }

        const strippedText = streamText.replace(TESSERACT_HIDDEN_TEXT_OBJECT_RE, '');
        if (isTextOnlyOcrStream(streamText, strippedText)) {
            Contents.remove(index);
            if (contentRef instanceof PDFRef) {
                context.delete(contentRef);
            }
            continue;
        }

        if (strippedText !== streamText) {
            const strippedRef = context.register(context.flateStream(strippedText));
            Contents.set(index, strippedRef);
            keptContentText.push(strippedText);
            continue;
        }

        keptContentText.push(streamText);
    }

    const keptText = keptContentText.join('\n');
    deleteUnreferencedEntries(Font, collectResourceNames(keptText, FONT_DRAW_RE));
    deleteUnreferencedEntries(XObject, collectResourceNames(keptText, IMAGE_OR_FORM_DRAW_RE));
}

function appendOcrLayer(
    page: PDFPage,
    embeddedPage: Awaited<ReturnType<PDFDocument['embedPage']>>,
) {
    const xObjectName = page.node.newXObject('EvbOcrLayer', embeddedPage.ref);
    const xObjectToken = xObjectName.toString();
    const xScale = page.getWidth() / embeddedPage.width;
    const yScale = page.getHeight() / embeddedPage.height;
    const stream = [
        `% ${OCR_LAYER_MARKER}_BEGIN`,
        'q',
        `${xScale} 0 0 ${yScale} 0 0 cm`,
        `${xObjectToken} Do`,
        'Q',
        `% ${OCR_LAYER_MARKER}_END`,
        '',
    ].join('\n');

    const contentRef = page.doc.context.register(page.doc.context.flateStream(stream));
    page.node.addContentStream(contentRef);
}

export async function assembleSearchablePdf(
    _qpdfBinary: string,
    originalPdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageCount: number,
    tempDir: string,
    sessionId: string,
    log: TWorkerLog,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    log('debug', `Replacing OCR text layer for ${ocrPdfMap.size} page(s) while preserving original PDF pages`);
    await assertNonEmptyFile(originalPdfPath, 'Original PDF');
    await Promise.all(Array.from(ocrPdfMap.entries()).map(
        ([
            pageNumber,
            ocrPath,
        ]) => assertNonEmptyFile(ocrPath, `OCR PDF page ${pageNumber}`),
    ));

    const ocrPageEntries = buildValidOcrPageEntries(ocrPdfMap, pageCount);
    if (ocrPageEntries.length === 0) {
        throw new Error('No valid OCR pages were available to assemble');
    }

    const originalPdfBytes = await readFile(originalPdfPath);
    const pdf = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
    const pages = pdf.getPages();
    throwIfAborted(signal);

    for (const [
        pageNumber,
        ocrPdfPath,
    ] of ocrPageEntries) {
        const page = pages[pageNumber - 1];
        if (!page) {
            continue;
        }

        removePreviousOcrLayer(page);
        const ocrPdfBytes = await readFile(ocrPdfPath);
        const ocrPdf = await PDFDocument.load(ocrPdfBytes, { ignoreEncryption: true });
        const embeddedOcrPage = await pdf.embedPage(ocrPdf.getPage(0));
        appendOcrLayer(page, embeddedOcrPage);
        throwIfAborted(signal);
    }

    const replacementPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));
    await writeFile(replacementPdfPath, await pdf.save({ useObjectStreams: true }));
    await assertNonEmptyFile(replacementPdfPath, 'Assembled OCR PDF');
    await assertReasonableOcrOutputSize(originalPdfPath, replacementPdfPath);
    throwIfAborted(signal);

    return replacementPdfPath;
}
