import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platform-api';
import type { TTranslateFn } from '@i18n-app';
import { getDocumentRefBaseName } from '@app/utils/document-ref';
import {
    loadOcrText,
    extractPdfText,
} from '@app/utils/ocr/processing';
import { getDocumentsCapability } from '@app/utils/platform-documents';

type TDocxBuilder = (text: string, hasRtl: boolean) => Uint8Array | Promise<Uint8Array>;

export async function exportTextAsDocx(params: {
    workingCopyPath: TDocumentRef | null;
    pdfDocument: PDFDocumentProxy | null;
    hasRtl: boolean;
    buildDocx: TDocxBuilder;
    t: TTranslateFn;
    toast: ReturnType<typeof useToast>;
    setError: (message: string) => void;
    localizeError: (error: unknown) => string;
    onSuccess?: () => void;
}): Promise<boolean> {
    try {
        const documents = getDocumentsCapability();
        const workingPath = params.workingCopyPath ?? '';
        const outPath = await documents.saveDocxAs(workingPath);
        if (!outPath) {
            return false;
        }

        try {
            let text = params.workingCopyPath ? await loadOcrText(params.workingCopyPath) : null;
            if (!text && params.pdfDocument) {
                text = await extractPdfText(params.pdfDocument);
            }
            if (!text) {
                params.setError(params.t('errors.ocr.noText'));
                return false;
            }

            const docxBytes = await params.buildDocx(text, params.hasRtl);
            await documents.writeDocxFile(outPath, docxBytes);
            params.onSuccess?.();
            params.toast.add({
                color: 'success',
                title: params.t('notifications.docxSavedTitle'),
                description: params.t('notifications.docxSavedDescription', {name: getDocumentRefBaseName(outPath) ?? outPath}),
            });
            return true;
        } finally {
            await documents.cleanupFile(outPath).catch(() => {});
        }
    } catch (error) {
        params.setError(params.localizeError(error));
        return false;
    }
}
