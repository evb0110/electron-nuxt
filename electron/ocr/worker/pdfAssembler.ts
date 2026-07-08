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
    PDFArray,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type {
    PDFDict,
    PDFPage,
} from 'pdf-lib';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    safePdfContextLookupArray,
    safePdfContextLookupStream,
    safePdfDictLookupDict,
    safePdfPageInheritableDict,
} from '@pdf-core';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const TESSERACT_IMAGE_PAINT_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+\/Im\d+\s+Do\s+Q\r?\n/gm;
const TESSERACT_IMAGE_XOBJECT_RE = /\n\s*\/XObject\s*<<\s*\n(?:\s*\/Im\d+\s+\d+\s+\d+\s+R\s*\n)+\s*>>/g;
const XOBJECT_DRAW_LINE_RE = /^[^\r\n]*\/[A-Za-z0-9._-]+\s+Do\b[^\r\n]*(?:\r?\n)?/gm;
const OCR_LAYER_MARKER = 'EVB_VIEWER_OCR_LAYER';
const MAX_OCR_OUTPUT_ABSOLUTE_GROWTH_BYTES = 100 * 1024 * 1024;
const MAX_OCR_OUTPUT_GROWTH_MULTIPLIER = 4;
const INVISIBLE_TEXT_RENDERING_RE = /(?:^|\s)3(?:\.0+)?\s+Tr\b/;
const TEXT_RENDERING_MODE_RE = /(^|\s)[0-7](?:\.0+)?\s+Tr\b/gm;
const TEXT_OBJECT_BEGIN_RE = /\bBT\b/g;
const IMAGE_OR_FORM_DRAW_TEST_RE = /\/[A-Za-z0-9._-]+\s+Do\b/;
const IMAGE_OR_FORM_DRAW_RE = /\/([A-Za-z0-9._-]+)\s+Do\b/g;
const FONT_DRAW_RE = /\/([A-Za-z0-9._-]+)\s+[-+0-9.]+\s+Tf\b/g;
const TESSERACT_HIDDEN_TEXT_OBJECT_RE = /BT[\s\S]*?(?:^|\s)3(?:\.0+)?\s+Tr\b[\s\S]*?ET\s*/gm;
const TESSERACT_EMPTY_TEXT_ONLY_PREAMBLE_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+Q\s*$/;
const CONTENTS_NAME = PDFName.of('Contents');
const RESOURCES_NAME = PDFName.of('Resources');
const FONT_NAME = PDFName.of('Font');
const XOBJECT_NAME = PDFName.of('XObject');
const EXT_G_STATE_NAME = PDFName.of('ExtGState');
const EXT_G_STATE_TYPE_NAME = PDFName.of('ExtGState');
const EXT_G_STATE_APPLY_RE = /\/([A-Za-z0-9._-]+)\s+gs\b/g;

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
            return {
                pageCount: parsed,
                warnings: [],
            };
        }
    } catch (err) {
        return {
            pageCount: fallback,
            warnings: [`qpdf page-count failed; using OCR page fallback ${fallback}: ${err instanceof Error ? err.message : String(err)}`],
        };
    }
    return {
        pageCount: fallback,
        warnings: [`qpdf page-count returned no usable page count; using OCR page fallback ${fallback}`],
    };
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

export function sanitizeOcrContentStreamForEmbedding(streamText: string) {
    const withoutGeneratedImagePaint = streamText
        .replace(TESSERACT_IMAGE_PAINT_RE, '')
        .replace(XOBJECT_DRAW_LINE_RE, '');
    return withoutGeneratedImagePaint
        .replace(TEXT_RENDERING_MODE_RE, (_match, prefix: string) => `${prefix}3 Tr`)
        .replace(TEXT_OBJECT_BEGIN_RE, 'BT\n3 Tr');
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
    const context = page.doc.context;
    const resources = safePdfPageInheritableDict(page, RESOURCES_NAME)?.clone(context) ?? context.obj({});
    const font = safePdfDictLookupDict(resources, FONT_NAME)?.clone(context) ?? context.obj({});
    const xObject = safePdfDictLookupDict(resources, XOBJECT_NAME)?.clone(context) ?? context.obj({});
    const extGState = safePdfDictLookupDict(resources, EXT_G_STATE_NAME)?.clone(context) ?? context.obj({});
    resources.set(FONT_NAME, font);
    resources.set(XOBJECT_NAME, xObject);
    resources.set(EXT_G_STATE_NAME, extGState);
    page.node.set(RESOURCES_NAME, resources);
    return {
        extGState,
        font,
        resources,
        xObject,
    };
}

function resolvePageContentsArray(page: PDFPage) {
    const context = page.doc.context;
    const contentsValue = page.node.get(CONTENTS_NAME);
    if (contentsValue instanceof PDFArray) {
        return contentsValue;
    }
    if (contentsValue instanceof PDFRef) {
        const contents = safePdfContextLookupArray(context, contentsValue);
        if (contents) {
            return contents;
        }
    }

    const contents = context.obj([]);
    if (contentsValue instanceof PDFRef || contentsValue instanceof PDFStream) {
        contents.push(contentsValue);
    }
    page.node.set(CONTENTS_NAME, contents);
    return contents;
}

function lookupPageContentStream(page: PDFPage, value: unknown) {
    if (value instanceof PDFStream) {
        return value;
    }
    if (value instanceof PDFRef) {
        return safePdfContextLookupStream(page.doc.context, value);
    }
    return null;
}

function isTextOnlyOcrStream(streamText: string, strippedText: string) {
    if (IMAGE_OR_FORM_DRAW_TEST_RE.test(streamText)) {
        return false;
    }
    return strippedText.trim().replace(TESSERACT_EMPTY_TEXT_ONLY_PREAMBLE_RE, '').trim() === '';
}

function removePreviousOcrLayer(page: PDFPage) {
    const {
        extGState,
        font,
        xObject,
    } = cloneMutablePageResources(page);
    const context = page.doc.context;
    const contents = resolvePageContentsArray(page);

    const keptContentText: string[] = [];
    for (let index = contents.size() - 1; index >= 0; index -= 1) {
        const contentRef = contents.get(index);
        const contentStream = lookupPageContentStream(page, contentRef);
        if (!contentStream) {
            continue;
        }
        const streamText = decodeContentStream(contentStream);

        if (streamText.includes(OCR_LAYER_MARKER)) {
            const markedXObjects = collectResourceNames(streamText, IMAGE_OR_FORM_DRAW_RE);
            contents.remove(index);
            if (contentRef instanceof PDFRef) {
                context.delete(contentRef);
            }
            for (const name of markedXObjects) {
                xObject.delete(PDFName.of(name));
            }
            for (const name of collectResourceNames(streamText, EXT_G_STATE_APPLY_RE)) {
                extGState.delete(PDFName.of(name));
            }
            continue;
        }

        if (!INVISIBLE_TEXT_RENDERING_RE.test(streamText)) {
            keptContentText.push(streamText);
            continue;
        }

        const strippedText = streamText.replace(TESSERACT_HIDDEN_TEXT_OBJECT_RE, '');
        if (isTextOnlyOcrStream(streamText, strippedText)) {
            contents.remove(index);
            if (contentRef instanceof PDFRef) {
                context.delete(contentRef);
            }
            continue;
        }

        // Mixed image/text streams sometimes use a single leading `3 Tr`
        // preamble to keep all following text invisible. Removing just that
        // preamble makes the original OCR layer paint over the scanned page.
        keptContentText.push(streamText);
    }

    const keptText = keptContentText.join('\n');
    deleteUnreferencedEntries(extGState, collectResourceNames(keptText, EXT_G_STATE_APPLY_RE));
    deleteUnreferencedEntries(font, collectResourceNames(keptText, FONT_DRAW_RE));
    deleteUnreferencedEntries(xObject, collectResourceNames(keptText, IMAGE_OR_FORM_DRAW_RE));
}

function sanitizeOcrPageForEmbedding(page: PDFPage) {
    const context = page.doc.context;
    const contents = resolvePageContentsArray(page);

    const sanitizedContentText: string[] = [];
    for (let index = 0; index < contents.size(); index += 1) {
        const contentRef = contents.get(index);
        const contentStream = lookupPageContentStream(page, contentRef);
        if (!contentStream) {
            continue;
        }

        const sanitizedText = sanitizeOcrContentStreamForEmbedding(decodeContentStream(contentStream));
        const sanitizedRef = context.register(context.flateStream(sanitizedText));
        contents.set(index, sanitizedRef);
        sanitizedContentText.push(sanitizedText);

        if (contentRef instanceof PDFRef) {
            context.delete(contentRef);
        }
    }

    const {
        extGState,
        font,
        xObject,
    } = cloneMutablePageResources(page);
    const keptText = sanitizedContentText.join('\n');
    deleteUnreferencedEntries(extGState, collectResourceNames(keptText, EXT_G_STATE_APPLY_RE));
    deleteUnreferencedEntries(font, collectResourceNames(keptText, FONT_DRAW_RE));
    deleteUnreferencedEntries(xObject, collectResourceNames(keptText, IMAGE_OR_FORM_DRAW_RE));
}

function appendOcrLayer(
    page: PDFPage,
    embeddedPage: Awaited<ReturnType<PDFDocument['embedPage']>>,
) {
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (rotation !== 0) {
        throw new Error(`Cannot safely add OCR text layer to rotated PDF page (${rotation} degrees)`);
    }

    const {
        extGState,
        xObject,
    } = cloneMutablePageResources(page);
    const xObjectName = xObject.uniqueKey('EvbOcrLayer');
    xObject.set(xObjectName, embeddedPage.ref);
    const invisibleStateName = extGState.uniqueKey('EvbOcrInvisible');
    extGState.set(invisibleStateName, page.doc.context.obj({
        Type: EXT_G_STATE_TYPE_NAME,
        CA: 0,
        ca: 0,
    }));
    const xObjectToken = xObjectName.toString();
    const invisibleStateToken = invisibleStateName.toString();
    const xScale = page.getWidth() / embeddedPage.width;
    const yScale = page.getHeight() / embeddedPage.height;
    const stream = [
        `% ${OCR_LAYER_MARKER}_BEGIN`,
        'q',
        `${invisibleStateToken} gs`,
        `${xScale} 0 0 ${yScale} 0 0 cm`,
        `${xObjectToken} Do`,
        'Q',
        `% ${OCR_LAYER_MARKER}_END`,
        '',
    ].join('\n');

    const contentRef = page.doc.context.register(page.doc.context.flateStream(stream));
    resolvePageContentsArray(page).push(contentRef);
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
        const ocrPage = ocrPdf.getPage(0);
        sanitizeOcrPageForEmbedding(ocrPage);
        const embeddedOcrPage = await pdf.embedPage(ocrPage);
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
