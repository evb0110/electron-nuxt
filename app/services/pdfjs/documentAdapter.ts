import type { PDFDocumentProxy } from 'pdfjs-dist';

interface IRuntimeTransport {messageHandler?: unknown;}

type TRuntimePdfDocument = PDFDocumentProxy & {
    destroyed?: boolean;
    _transport?: IRuntimeTransport | null;
};

function isPdfDocumentDestroyed(pdfDocument: PDFDocumentProxy) {
    const runtimeDocument = pdfDocument as TRuntimePdfDocument;
    return runtimeDocument.destroyed === true;
}

function hasUsableDocumentTransport(pdfDocument: PDFDocumentProxy) {
    const runtimeDocument = pdfDocument as TRuntimePdfDocument;
    const transport = runtimeDocument._transport;

    if (transport === null) {
        return false;
    }

    if (
        transport
        && typeof transport === 'object'
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
