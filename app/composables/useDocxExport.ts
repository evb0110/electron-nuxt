import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platform-api';
import { getElectronAPI } from '@app/utils/platform';
import { createDocxFromTextAsync } from '@app/utils/docx';
import {
    loadOcrText,
    extractPdfText,
} from '@app/composables/ocrProcessing';
import { createOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';
import { useAnalytics } from '@app/composables/useAnalytics';

const RTL_OCR_LANGUAGES = new Set([
    'heb',
    'syr',
]);

export const useDocxExport = () => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const { localizeOcrError } = createOcrErrorLocalizer(t);

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
            let text = params.workingCopyPath ? await loadOcrText(params.workingCopyPath) : null;
            if (!text && params.pdfDocument) {
                text = await extractPdfText(params.pdfDocument);
            }
            if (!text) {
                docxExportError.value = t('errors.ocr.noText');
                return false;
            }

            const api = getElectronAPI();
            const outPath = await api.documents.saveDocxAs(workingPath);
            if (!outPath) {
                return false;
            }

            try {
                const hasRtl = selectedLanguages.some(lang => RTL_OCR_LANGUAGES.has(lang));
                const docxBytes = await createDocxFromTextAsync(text, hasRtl);
                await api.documents.writeDocxFile(outPath, docxBytes);
                analytics.track('export_completed', {
                    format: 'docx',
                    hasRtl,
                    selectedLanguageCount: selectedLanguages.length,
                    status: 'success',
                });
                return true;
            } finally {
                await api.documents.cleanupFile(outPath).catch(() => {});
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
