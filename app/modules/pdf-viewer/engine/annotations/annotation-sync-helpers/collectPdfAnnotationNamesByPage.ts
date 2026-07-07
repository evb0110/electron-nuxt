import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import {
    PDFArray,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import { getPdfStringValue } from '@app/utils/pdfDict';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { iterateAnnotationRefDicts } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/iterateAnnotationRefDicts';

const ANNOTATION_NAME = PDFName.of('NM');

export type TPdfAnnotationNamesByPage = Map<number, Map<string, string>>;

export async function collectPdfAnnotationNamesByPage(
    doc: PDFDocumentProxy,
    options?: { allowFullRead?: boolean | undefined },
): Promise<TPdfAnnotationNamesByPage> {
    if (options?.allowFullRead === false) {
        return new Map();
    }

    const data = await doc.getData();
    const pdfDocument = await PDFDocument.load(data, { updateMetadata: false });
    const namesByPage: TPdfAnnotationNamesByPage = new Map();

    pdfDocument.getPages().forEach((page, pageIndex) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return;
        }

        const namesByAnnotationId = new Map<string, string>();
        for (const {
            dict,
            ref,
        } of iterateAnnotationRefDicts(pdfDocument, annots)) {
            const annotationName = getPdfStringValue(dict.get(ANNOTATION_NAME)).trim();
            if (annotationName) {
                namesByAnnotationId.set(formatPdfJsAnnotationRef(ref), annotationName);
            }
        }
        if (namesByAnnotationId.size > 0) {
            namesByPage.set(pageIndex, namesByAnnotationId);
        }
    });

    return namesByPage;
}
