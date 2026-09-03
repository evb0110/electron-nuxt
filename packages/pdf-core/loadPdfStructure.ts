import {
    PDFDict,
    PDFDocument,
    PDFName,
} from 'pdf-lib';

export interface ILoadedPdfStructure {
    doc: PDFDocument;
    acroForm: PDFDict | null;
    structTreeRoot: PDFDict | null;
    hasXfa: boolean;
}

export async function loadPdfStructure(data: Uint8Array): Promise<ILoadedPdfStructure> {
    const doc = await PDFDocument.load(data, {
        ignoreEncryption: true,
        updateMetadata: false,
    });
    const catalog = doc.catalog;
    const acroFormCandidate = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const structTreeRootCandidate = catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);
    const acroForm = acroFormCandidate instanceof PDFDict ? acroFormCandidate : null;
    const structTreeRoot = structTreeRootCandidate instanceof PDFDict ? structTreeRootCandidate : null;
    const hasXfa = acroForm !== null && acroForm.has(PDFName.of('XFA'));

    return {
        doc,
        acroForm,
        structTreeRoot,
        hasXfa,
    };
}
