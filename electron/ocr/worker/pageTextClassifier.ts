import { readFile } from 'node:fs/promises';
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
    safePdfPageInheritableDict,
} from '@pdf-core';

const CONTENTS_NAME = PDFName.of('Contents');
const RESOURCES_NAME = PDFName.of('Resources');
const XOBJECT_NAME = PDFName.of('XObject');
const TEXT_TOKEN_RE = /\bBT\b|\bET\b|(?:^|\s)([0-7])(?:\.0+)?\s+Tr\b|\b(Tj|TJ)\b|(?:^|\s)(['"])(?=\s|$)/gm;

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

function decodeStream(stream: PDFStream) {
    if (stream instanceof PDFRawStream) {
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    if (stream instanceof PDFContentStream) {
        return Buffer.from(stream.getUnencodedContents()).toString('latin1');
    }
    return '';
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
            if (value instanceof PDFStream) add(value);
            if (value instanceof PDFRef) add(safePdfContextLookupStream(page.doc.context, value));
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
): Promise<Map<number, IOcrPdfTextVisibility>> {
    const pdf = await PDFDocument.load(await readFile(pdfPath), {ignoreEncryption: true});
    const evidence = new Map<number, ReturnType<typeof inspectPdfTextVisibility>>();
    for (const pageNumber of pageNumbers) {
        const page = pdf.getPage(pageNumber - 1);
        evidence.set(pageNumber, inspectPdfTextVisibility(resolvePageStreams(page).map(decodeStream)));
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
