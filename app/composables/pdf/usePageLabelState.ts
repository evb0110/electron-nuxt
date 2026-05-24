import type { Ref } from 'vue';
import { isEqual } from 'es-toolkit/predicate';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IPdfPageLabelRange } from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdfPageLabels';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';

export function resolveVisiblePageLabelsDuringMetadataRefresh(options: {
    pageLabels: string[] | null;
    pageLabelsResolved: boolean;
    isSaving: boolean;
    totalPages: number;
}) {
    const {
        pageLabels,
        pageLabelsResolved,
        isSaving,
        totalPages,
    } = options;

    if (pageLabelsResolved || isSaving) {
        return pageLabels;
    }

    return pageLabels?.length === totalPages ? pageLabels : null;
}

export const usePageLabelState = (deps: {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    totalPages: Ref<number>;
    markDirty: () => void;
    onPageLabelsSynchronized?: () => void;
    onPageLabelsDirty?: () => void;
    onPageLabelsSaved?: () => void;
}) => {
    const {
        pdfDocument,
        totalPages,
        markDirty,
        onPageLabelsSynchronized,
        onPageLabelsDirty,
        onPageLabelsSaved,
    } = deps;

    const pageLabels = ref<string[] | null>(null);
    const pageLabelRanges = ref<IPdfPageLabelRange[]>([]);
    const pageLabelsDirty = ref(false);
    const pageLabelsResolved = ref(true);

    function materializePageLabels(
        totalPagesValue: number,
        ranges: IPdfPageLabelRange[],
        labels: string[] | null = null,
    ) {
        if (totalPagesValue <= 0 || isImplicitDefaultPageLabels(ranges, totalPagesValue)) {
            return null;
        }

        if (labels && labels.length === totalPagesValue) {
            return labels;
        }

        return buildPageLabelsFromRanges(totalPagesValue, ranges);
    }

    async function syncPageLabelsFromDocument(doc: PDFDocumentProxy | null) {
        if (!doc) {
            if (totalPages.value <= 0) {
                pageLabels.value = null;
                pageLabelRanges.value = [];
            }
            pageLabelsDirty.value = false;
            pageLabelsResolved.value = true;
            onPageLabelsSynchronized?.();
            return;
        }

        pageLabelsResolved.value = false;

        try {
            let labels: string[] | null = null;
            try {
                const raw = await doc.getPageLabels();
                labels = raw && raw.length === doc.numPages ? raw : null;
            } catch (error) {
                BrowserLogger.debug(
                    'page-labels',
                    'Failed to read page labels from PDF document',
                    error,
                );
                labels = null;
            }

            const nextRanges = derivePageLabelRangesFromLabels(
                labels,
                doc.numPages,
            );
            pageLabelRanges.value = nextRanges;
            pageLabels.value = materializePageLabels(doc.numPages, nextRanges, labels);
            pageLabelsDirty.value = false;
        } finally {
            pageLabelsResolved.value = true;
            onPageLabelsSynchronized?.();
        }
    }

    function markPageLabelsSaved() {
        pageLabelsDirty.value = false;
        onPageLabelsSaved?.();
    }

    function handlePageLabelRangesUpdate(ranges: IPdfPageLabelRange[]) {
        if (totalPages.value <= 0) {
            return;
        }

        const normalized = normalizePageLabelRanges(ranges, totalPages.value);
        const currentNormalized = normalizePageLabelRanges(
            pageLabelRanges.value,
            totalPages.value,
        );
        const unchanged = isEqual(normalized, currentNormalized);
        if (unchanged) {
            return;
        }
        pageLabelRanges.value = normalized;
        pageLabels.value = materializePageLabels(totalPages.value, normalized);
        pageLabelsDirty.value = true;
        markDirty();
        onPageLabelsDirty?.();
    }

    function scheduleSyncPageLabelsFromDocument(doc: PDFDocumentProxy | null) {
        runGuardedTask(() => syncPageLabelsFromDocument(doc), {
            scope: 'page-labels',
            message: 'Failed to synchronize page labels from PDF document',
        });
    }

    watch(
        pdfDocument,
        (doc) => {
            if (doc) {
                pageLabelsResolved.value = false;
            }
            scheduleSyncPageLabelsFromDocument(doc);
        },
        { immediate: true },
    );

    return {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pageLabelsResolved,
        syncPageLabelsFromDocument,
        markPageLabelsSaved,
        handlePageLabelRangesUpdate,
    };
};
