import type {PDFDocumentProxy} from '@app/types/pdfContracts';

interface IPdfDocumentProxyFixture {readonly annotationStorage: object;}

export function createPdfDocumentProxy(
    fixture: IPdfDocumentProxyFixture = {annotationStorage: {}},
): PDFDocumentProxy {
    // The consumers covered by this fixture read only annotationStorage. Keep
    // the intentionally small proxy explicit instead of hiding an arbitrary
    // object-to-PDFDocumentProxy conversion behind a generic cast helper.
    return fixture as PDFDocumentProxy;
}
