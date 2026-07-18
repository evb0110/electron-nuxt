import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TTranslateFn } from '@i18n-app';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import { loadDocumentTextCatalogPages } from '@app/utils/ocr/loadOcrText';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';

type TDocxBuilder = (text: string, hasRtl: boolean) => Uint8Array | Promise<Uint8Array>;

const DOCX_EXPORT_MAX_TEXT_CHARACTERS = 3 * 1024 * 1024;
const DOCX_EXPORT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function exportTextAsDocx(params: {
    workingCopyPath: TDocumentRef | null;
    documentRevisionToken: TDocumentRevisionToken | null;
    pdfDocument: PDFDocumentProxy | null;
    hasRtl: boolean;
    buildDocx: TDocxBuilder;
    t: TTranslateFn;
    toast: ReturnType<typeof useToast>;
    setError: (message: string) => void;
    localizeError: (error: unknown) => string;
    onSuccess?: () => void;
}) {
    try {
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        const workingPath = params.workingCopyPath ?? '';
        const outPath = await documentFiles.saveDocxAs(workingPath);
        if (!outPath) {
            return false;
        }

        try {
            const catalogPages = params.workingCopyPath && params.documentRevisionToken
                ? await loadDocumentTextCatalogPages(
                    params.workingCopyPath,
                    params.documentRevisionToken,
                    params.pdfDocument?.numPages,
                )
                : null;
            let catalogTextLength = 0;
            const catalogTextParts: string[] = [];
            for (const page of catalogPages ?? []) {
                const pageText = page.text.trim();
                if (!pageText) continue;
                catalogTextLength += pageText.length + (catalogTextParts.length > 0 ? 2 : 0);
                if (catalogTextLength > DOCX_EXPORT_MAX_TEXT_CHARACTERS) {
                    throw new RangeError('DOCX export text exceeds the 3 MiB character budget');
                }
                catalogTextParts.push(pageText);
            }
            const catalogText = catalogTextParts.join('\n\n');
            const text = catalogText && catalogText.length > 0 ? catalogText : null;
            if (!text) {
                params.setError(params.t('errors.ocr.noText'));
                return false;
            }

            const docxBytes = await params.buildDocx(text, params.hasRtl);
            if (docxBytes.byteLength > DOCX_EXPORT_MAX_OUTPUT_BYTES) {
                throw new RangeError('DOCX export exceeds the 16 MiB output limit');
            }
            await documentFiles.writeDocxFile(outPath, docxBytes);
            params.onSuccess?.();
            params.toast.add({
                color: 'success',
                title: params.t('notifications.docxSavedTitle'),
                description: params.t('notifications.docxSavedDescription', {name: getDocumentRefBaseName(outPath) ?? outPath}),
            });
            return true;
        } finally {
            if (isBrowserDocumentRef(outPath)) {
                await documentWorkingCopy.cleanupFile(outPath).catch(() => {});
            }
        }
    } catch (error) {
        params.setError(params.localizeError(error));
        return false;
    }
}
