import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platform-api';
import { createDocxFromTextAsync } from '@app/utils/docx';
import {
    loadOcrText,
    extractPdfText,
} from '@app/composables/ocrProcessing';
import { useOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';
import { useAnalytics } from '@app/composables/useAnalytics';
import { getDocumentRefBaseName } from '@app/utils/document-ref';
import { getDocumentsCapability } from '@app/utils/platform-documents';

const RTL_OCR_LANGUAGES = new Set([
    'heb',
    'syr',
]);

export const useDocxExport = () => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const { localizeOcrError } = useOcrErrorLocalizer();

    const isExportingDocx = ref(false);
    const docxExportError = ref<string | null>(null);

    async function exportDocx(params: {
        workingCopyPath: TDocumentRef | null;
        pdfDocument: PDFDocumentProxy | null;
        selectedLanguages?: string[];
    }): Promise<boolean> {
        if (isExportingDocx.value) {
            return false;
        }

        const workingPath = params.workingCopyPath ?? '';
        const selectedLanguages = params.selectedLanguages ?? [];
        isExportingDocx.value = true;
        docxExportError.value = null;

        try {
            const documents = getDocumentsCapability();
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
                    docxExportError.value = t('errors.ocr.noText');
                    return false;
                }

                const hasRtl = selectedLanguages.some(lang => RTL_OCR_LANGUAGES.has(lang));
                const docxBytes = await createDocxFromTextAsync(text, hasRtl);
                await documents.writeDocxFile(outPath, docxBytes);
                analytics.track('export_completed', {
                    format: 'docx',
                    hasRtl,
                    selectedLanguageCount: selectedLanguages.length,
                    status: 'success',
                });
                toast.add({
                    color: 'success',
                    title: t('notifications.docxSavedTitle'),
                    description: t('notifications.docxSavedDescription', {name: getDocumentRefBaseName(outPath) ?? outPath}),
                });
                return true;
            } finally {
                await documents.cleanupFile(outPath).catch(() => {});
            }
        } catch (error) {
            docxExportError.value = localizeOcrError(error, 'errors.ocr.exportDocx');
            return false;
        } finally {
            isExportingDocx.value = false;
        }
    }

    function clearDocxExportError() {
        docxExportError.value = null;
    }

    return {
        isExportingDocx,
        docxExportError,
        exportDocx,
        clearDocxExportError,
    };
};
