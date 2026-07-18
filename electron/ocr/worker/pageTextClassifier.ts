import {
    readFile,
    stat,
} from 'node:fs/promises';
import {
    decodePDFRawStream,
    PDFArray,
    PDFContentStream,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type {PDFPage} from 'pdf-lib';
import type {
    TOcrPageTextClassification,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import {
    safePdfContextLookupStream,
    safePdfDictLookupDict,
    safePdfDictLookupName,
    safePdfPageInheritableDict,
} from '@pdf-core';

const CONTENTS_NAME = PDFName.of('Contents');
const RESOURCES_NAME = PDFName.of('Resources');
const XOBJECT_NAME = PDFName.of('XObject');
const SUBTYPE_NAME = PDFName.of('Subtype');
const FORM_NAME = PDFName.of('Form');
const TEXT_TOKEN_RE = /\bBT\b|\bET\b|(?:^|\s)([0-7])(?:\.0+)?\s+Tr\b|\b(Tj|TJ)\b|(?:^|\s)(['"])(?=\s|$)/gm;
const OCR_TEXT_VISIBILITY_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_MAX_STREAM_BYTES = 4 * 1024 * 1024;
const OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES = 16 * 1024 * 1024;

export interface IOcrPageTextEvidence {
    classification: TOcrPageTextClassification;
    extractedTextLength: number;
    hasHiddenTextOperators: boolean;
    hasVisibleTextOperators: boolean;
    evbGeneration?: string;
}

export interface IOcrPdfTextVisibility {
    hasHiddenTextOperators: boolean;
    hasVisibleTextOperators: boolean;
}

function decodeStream(stream: PDFStream, maxBytes: number) {
    const byteLimit = Math.max(0, Math.min(maxBytes, OCR_TEXT_VISIBILITY_MAX_STREAM_BYTES));
    if (byteLimit === 0) {
        throw new RangeError('OCR text-visibility decoded page budget reached');
    }
    let bytes: Uint8Array | Uint8ClampedArray;
    if (stream instanceof PDFRawStream) {
        bytes = decodePDFRawStream(stream).getBytes(byteLimit + 1);
    } else if (stream instanceof PDFContentStream) {
        bytes = stream.getUnencodedContents();
    } else {
        return '';
    }
    if (bytes.byteLength > byteLimit) {
        throw new RangeError(`OCR text-visibility stream exceeds ${byteLimit} decoded bytes`);
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

function resolvePageStreams(page: PDFPage) {
    const streams: PDFStream[] = [];
    const seen = new Set<PDFStream>();
    const add = (stream: PDFStream | null) => {
        if (stream && !seen.has(stream)) {
            seen.add(stream);
            streams.push(stream);
        }
    };
    const contents = page.node.get(CONTENTS_NAME);
    if (contents instanceof PDFStream) {
        add(contents);
    } else if (contents instanceof PDFRef) {
        add(safePdfContextLookupStream(page.doc.context, contents));
    } else if (contents instanceof PDFArray) {
        for (let index = 0; index < contents.size(); index += 1) {
            const item = contents.get(index);
            if (item instanceof PDFStream) add(item);
            if (item instanceof PDFRef) add(safePdfContextLookupStream(page.doc.context, item));
        }
    }

    const resources = safePdfPageInheritableDict(page, RESOURCES_NAME);
    const xObjects = resources ? safePdfDictLookupDict(resources, XOBJECT_NAME) : null;
    if (xObjects) {
        for (const key of xObjects.keys()) {
            const value = xObjects.get(key);
            const stream = value instanceof PDFStream
                ? value
                : value instanceof PDFRef
                    ? safePdfContextLookupStream(page.doc.context, value)
                    : null;
            // Image XObjects cannot contain text operators. Decoding them here
            // turned a cheap classification pass into full scan-image decode.
            if (stream && safePdfDictLookupName(stream.dict, SUBTYPE_NAME) === FORM_NAME) {
                add(stream);
            }
        }
    }
    return streams;
}

export function inspectPdfTextVisibility(streamSources: readonly string[]): IOcrPdfTextVisibility {
    let renderingMode = 0;
    let inTextObject = false;
    let hasHiddenTextOperators = false;
    let hasVisibleTextOperators = false;

    for (const source of streamSources) {
        TEXT_TOKEN_RE.lastIndex = 0;
        for (const match of source.matchAll(TEXT_TOKEN_RE)) {
            const token = match[0].trim();
            if (token === 'BT') {
                inTextObject = true;
            } else if (token === 'ET') {
                inTextObject = false;
            } else if (match[1] !== undefined) {
                renderingMode = Number(match[1]);
            } else if (inTextObject && (match[2] !== undefined || match[3] !== undefined)) {
                if (renderingMode === 3) hasHiddenTextOperators = true;
                else hasVisibleTextOperators = true;
            }
        }
    }
    return {
        hasHiddenTextOperators,
        hasVisibleTextOperators,
    };
}

export async function inspectPdfPageTextVisibility(
    pdfPath: string,
    pageNumbers: readonly number[],
    signal?: AbortSignal,
): Promise<Map<number, IOcrPdfTextVisibility>> {
    if (signal?.aborted) {
        throw signal.reason;
    }
    const fileStat = await stat(pdfPath);
    if (fileStat.size > OCR_TEXT_VISIBILITY_MAX_INPUT_BYTES) {
        throw new RangeError(
            `OCR text-visibility inspection is limited to ${OCR_TEXT_VISIBILITY_MAX_INPUT_BYTES} input bytes`,
        );
    }
    const pdf = await PDFDocument.load(await readFile(pdfPath), {ignoreEncryption: true});
    const evidence = new Map<number, ReturnType<typeof inspectPdfTextVisibility>>();
    for (const pageNumber of pageNumbers) {
        if (signal?.aborted) {
            throw signal.reason;
        }
        const page = pdf.getPage(pageNumber - 1);
        let remainingBytes = OCR_TEXT_VISIBILITY_MAX_PAGE_BYTES;
        const sources: string[] = [];
        for (const stream of resolvePageStreams(page)) {
            const source = decodeStream(stream, remainingBytes);
            remainingBytes -= source.length;
            sources.push(source);
            const visibility = inspectPdfTextVisibility(sources);
            if (visibility.hasHiddenTextOperators && visibility.hasVisibleTextOperators) {
                break;
            }
        }
        evidence.set(pageNumber, inspectPdfTextVisibility(sources));
    }
    return evidence;
}

export function classifyOcrPageText(input: {
    extractedText: string;
    visibility?: IOcrPdfTextVisibility;
    evbGeneration?: string;
}): IOcrPageTextEvidence {
    const extractedTextLength = input.extractedText.trim().length;
    const hasHiddenTextOperators = input.visibility?.hasHiddenTextOperators ?? false;
    const hasVisibleTextOperators = input.visibility?.hasVisibleTextOperators ?? false;
    if (input.evbGeneration) {
        return {
            classification: 'evb-current-generation',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
            evbGeneration: input.evbGeneration,
        };
    }
    if (extractedTextLength === 0) {
        return {
            classification: 'no-text',
            extractedTextLength,
            hasHiddenTextOperators,
            hasVisibleTextOperators,
        };
    }
    return {
        classification: hasHiddenTextOperators && !hasVisibleTextOperators
            ? 'foreign-hidden-ocr'
            : 'native-text',
        extractedTextLength,
        hasHiddenTextOperators,
        hasVisibleTextOperators,
    };
}

export function shouldOcrClassifiedPage(
    classification: TOcrPageTextClassification,
    policy: TOcrTextSupersessionPolicy,
) {
    if (classification === 'no-text') {
        return true;
    }
    if (classification === 'evb-current-generation') {
        return policy === 'replace-evb' || policy === 'replace-all';
    }
    if (classification === 'foreign-hidden-ocr') {
        return policy === 'replace-all';
    }
    return false;
}
