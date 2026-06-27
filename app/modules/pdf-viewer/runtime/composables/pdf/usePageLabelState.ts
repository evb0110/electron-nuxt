import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
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
        onPageLabelsSynchronized,
        onPageLabelsDirty,
        onPageLabelsSaved,
    } = deps;

    const pageLabels = ref<string[] | null>(null);
    const pageLabelRanges = ref<IPdfPageLabelRange[]>([]);
    const pageLabelsDirty = ref(false);
    const pageLabelsResolved = ref(true);
    let pageLabelSyncGeneration = 0;
    let pageLabelRevision = 0;
    let disposed = false;

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
        const syncGeneration = ++pageLabelSyncGeneration;
        const isCurrentSync = () => (
            !disposed
            && pageLabelSyncGeneration === syncGeneration
            && pdfDocument.value === doc
        );

        if (!isCurrentSync()) {
            return;
        }

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

            if (!isCurrentSync()) {
                return;
            }
            const nextRanges = derivePageLabelRangesFromLabels(
                labels,
                doc.numPages,
            );
            pageLabelRanges.value = nextRanges;
            pageLabels.value = materializePageLabels(doc.numPages, nextRanges, labels);
            pageLabelsDirty.value = false;
            pageLabelRevision += 1;
        } finally {
            if (isCurrentSync()) {
                pageLabelsResolved.value = true;
                onPageLabelsSynchronized?.();
            }
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
        pageLabelRevision += 1;
        onPageLabelsDirty?.();
    }

    function getPageLabelsRevision() {
        return pageLabelRevision;
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

    tryOnScopeDispose(() => {
        disposed = true;
        pageLabelSyncGeneration += 1;
    });

    return {
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        pageLabelsResolved,
        syncPageLabelsFromDocument,
        markPageLabelsSaved,
        getPageLabelsRevision,
        handlePageLabelRangesUpdate,
    };
};
