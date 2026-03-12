import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    getOptionalObject,
    isRecord,
} from '@app/services/pdfjs/runtime';

function isPdfDocumentDestroyed(pdfDocument: PDFDocumentProxy) {
    return isRecord(pdfDocument) && pdfDocument['destroyed'] === true;
}

function getRuntimeTransport(pdfDocument: PDFDocumentProxy) {
    if (!isRecord(pdfDocument) || !('_transport' in pdfDocument)) {
        return undefined;
    }

    return pdfDocument['_transport'];
}

function hasUsableDocumentTransport(pdfDocument: PDFDocumentProxy) {
    const transport = getOptionalObject(pdfDocument, '_transport') ?? getRuntimeTransport(pdfDocument);

    if (transport === null) {
        return false;
    }

    if (
        isRecord(transport)
        && 'messageHandler' in transport
        && transport.messageHandler == null
    ) {
        return false;
    }

    return true;
}

export function isPdfDocumentOperational(pdfDocument: PDFDocumentProxy) {
    if (isPdfDocumentDestroyed(pdfDocument)) {
        return false;
    }

    return hasUsableDocumentTransport(pdfDocument);
}
