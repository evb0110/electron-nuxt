import type {PDFDocumentProxy} from '@app/types/pdfContracts';
import {cast} from '@tests/helpers/cast';

export function createPdfDocumentProxy(value: object = {annotationStorage: {}}): PDFDocumentProxy {
    return cast<PDFDocumentProxy>(value);
}
