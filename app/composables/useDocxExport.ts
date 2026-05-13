import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platformApi';
import { createDocxFromTextAsync } from '@app/utils/docx';
import { useOcrErrorLocalizer } from '@app/composables/ocrErrorLocalization';
import { useAnalytics } from '@app/composables/useAnalytics';
import { hasRtlOcrLanguage } from '@app/utils/ocr/textDirection';
import { exportTextAsDocx } from '@app/utils/docxExport';

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

        const selectedLanguages = params.selectedLanguages ?? [];
        isExportingDocx.value = true;
        docxExportError.value = null;

        try {
            const hasRtl = hasRtlOcrLanguage(selectedLanguages);
            return await exportTextAsDocx({
                workingCopyPath: params.workingCopyPath,
                pdfDocument: params.pdfDocument,
                hasRtl,
                buildDocx: createDocxFromTextAsync,
                t,
                toast,
                setError: message => {
                    docxExportError.value = message;
                },
                localizeError: error => localizeOcrError(error, 'errors.ocr.exportDocx'),
                onSuccess: () => {
                    analytics.track('export_completed', {
                        format: 'docx',
                        hasRtl,
                        selectedLanguageCount: selectedLanguages.length,
                        status: 'success',
                    });
                },
            });
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
