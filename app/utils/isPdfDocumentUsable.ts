import type { PDFDocumentProxy } from 'pdfjs-dist';
import { isPdfDocumentOperational } from '@app/services/pdfjs/isPdfDocumentOperational';

/**
 * Check whether a PDFDocumentProxy is still in a usable state.
 *
 * pdf.js tears down internal state (nulls `_transport`, sets `destroyed`)
 * during `PDFDocumentProxy.destroy()`.  Calling methods like `getPage()`
 * or `render()` after destruction throws, so callers should bail early.
 */
export function isPdfDocumentUsable(pdfDocument: PDFDocumentProxy) {
    return isPdfDocumentOperational(pdfDocument);
}
