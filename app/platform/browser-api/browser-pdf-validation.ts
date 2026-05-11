import { loadPdfStructure } from '@contracts/pdf-conformance-load';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/platform-api';
import { browserDocumentStore } from '@app/platform/browser-document-store';
import {
    createPdfjsDocumentInit,
    getPdfjsLib,
} from '@app/platform/browser-api/common';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import {
    buildPdfSaveRestrictions,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText,
} from './browser-pdf-conformance-helpers';

const pdfBinaryDecoder = new TextDecoder('latin1');
const PDF_ENCRYPT_SCAN_REGION_BYTES = 32 * 1024;
const BROWSER_FULL_CONFORMANCE_ANALYSIS_BYTES = 64 * 1024 * 1024;

function decodePdfBinary(bytes: Uint8Array) {
    return pdfBinaryDecoder.decode(bytes);
}

export function containsPdfEncryptMarker(bytes: Uint8Array) {
    return decodePdfBinary(bytes).includes('/Encrypt');
}

function detectBrowserPdfaLevel(bytes: Uint8Array) {
    return detectPdfaLevelFromPdfText(decodePdfBinary(bytes));
}

function detectBrowserSignatureMarkers(bytes: Uint8Array) {
    return hasPdfSignatureMarkersInPdfText(decodePdfBinary(bytes));
}

async function readPdfMarkerRegions(path: string) {
    const { size } = await browserDocumentStore.stat(path);
    const head = await browserDocumentStore.readRange(
        path,
        0,
        Math.min(PDF_ENCRYPT_SCAN_REGION_BYTES, size),
    );
    const tailStart = Math.max(head.byteLength, size - PDF_ENCRYPT_SCAN_REGION_BYTES);
    const tail = tailStart < size
        ? await browserDocumentStore.readRange(path, tailStart, size - tailStart)
        : new Uint8Array();

    return {
        size,
        head,
        tail,
    };
}

function mergePdfMarkerRegions(head: Uint8Array, tail: Uint8Array) {
    const merged = new Uint8Array(head.byteLength + tail.byteLength);
    merged.set(head, 0);
    merged.set(tail, head.byteLength);
    return merged;
}

export async function analyzeBrowserPdfConformance(path: string): Promise<IPdfConformanceProfile> {
    const fallback = createDefaultPdfConformanceProfile();
    const {
        size,
        head,
        tail,
    } = await readPdfMarkerRegions(path);

    if (size > BROWSER_FULL_CONFORMANCE_ANALYSIS_BYTES) {
        const markers = mergePdfMarkerRegions(head, tail);
        const isEncrypted = containsPdfEncryptMarker(markers);
        const pdfaLevel = detectBrowserPdfaLevel(markers);
        const isSigned = detectBrowserSignatureMarkers(markers);
        const baseProfile = {
            isSigned,
            isEncrypted,
            isTagged: false,
            pdfaLevel,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: !isEncrypted,
        };

        return {
            ...baseProfile,
            saveRestrictions: buildPdfSaveRestrictions(baseProfile),
        };
    }

    const bytes = await browserDocumentStore.read(path);

    try {
        await yieldToBrowser();
        const {
            doc,
            acroForm,
            structTreeRoot,
            hasXfa,
        } = await loadPdfStructure(bytes);
        const baseProfile = {
            isSigned: detectBrowserSignatureMarkers(bytes),
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot !== null,
            pdfaLevel: detectBrowserPdfaLevel(bytes),
            hasAcroForm: acroForm !== null,
            hasXfa,
            canIncrementalSave: !doc.isEncrypted && !hasXfa,
        };

        return {
            ...baseProfile,
            saveRestrictions: buildPdfSaveRestrictions(baseProfile),
        };
    } catch {
        return {
            ...fallback,
            isSigned: detectBrowserSignatureMarkers(bytes),
            pdfaLevel: detectBrowserPdfaLevel(bytes),
            saveRestrictions: buildPdfSaveRestrictions({
                ...fallback,
                isSigned: detectBrowserSignatureMarkers(bytes),
                pdfaLevel: detectBrowserPdfaLevel(bytes),
            }),
        };
    }
}

export async function validateBrowserPdfData(data: Uint8Array): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        return {
            isValid: false,
            tool: 'browser',
            errors: ['PDF validation failed: empty document data'],
            warnings: [],
        };
    }

    try {
        await yieldToBrowser();
        const pdfjsLib = await getPdfjsLib();
        const loadingTask = pdfjsLib.getDocument(
            createPdfjsDocumentInit(pdfjsLib, data),
        );
        const pdfDocument = await loadingTask.promise;
        await pdfDocument.destroy();
        return {
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        };
    } catch (error) {
        return {
            isValid: false,
            tool: 'browser',
            errors: [error instanceof Error ? error.message : 'PDF validation failed'],
            warnings: [],
        };
    }
}
