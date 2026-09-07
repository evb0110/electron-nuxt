import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    type getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import {adaptPdfjsDocument} from '@app/services/pdfjs/pdfjsCompatibility';

type TBrowserPdfjsLib = Awaited<ReturnType<typeof getPdfjsLib>>;

export async function loadBrowserPdfjsDocument(
    pdfjsLib: TBrowserPdfjsLib,
    path: string,
): Promise<IPdfDocument> {
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    const loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, path, {onRangeReadFailure: (error) => {
        const reject = rejectRangeReadFailure;
        rejectRangeReadFailure = null;
        reject?.(error);
    }}));
    try {
        const loadedDocument = await Promise.race([
            loadingTask.promise,
            rangeReadFailure,
        ]);
        return adaptPdfjsDocument(loadedDocument, () => loadingTask.destroy());
    } catch (error) {
        await loadingTask.destroy();
        throw error;
    } finally {
        rejectRangeReadFailure = null;
    }
}
