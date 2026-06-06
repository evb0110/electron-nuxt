import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { Ref } from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageLabelState } from '@app/composables/pdf/usePageLabelState';
import { resolveVisiblePageLabelsDuringMetadataRefresh } from '@app/utils/pdf-viewer/page-labels/resolveVisiblePageLabelsDuringMetadataRefresh';
import type { IPdfPageLabelRange } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

function createPdfDocumentRef(
    numPages: number,
    getPageLabels: () => Promise<string[] | null>,
) {
    return cast<Ref<PDFDocumentProxy | null>>(ref({
        numPages,
        getPageLabels,
    }));
}

describe('usePageLabelState', () => {
    it('keeps complete labels visible while refreshed document metadata is unresolved', () => {
        const labels = [
            'i',
            'ii',
            '1',
        ];

        expect(resolveVisiblePageLabelsDuringMetadataRefresh({
            pageLabels: labels,
            pageLabelsResolved: false,
            isSaving: false,
            totalPages: 3,
        })).toBe(labels);
    });

    it('hides incomplete labels while refreshed document metadata is unresolved', () => {
        expect(resolveVisiblePageLabelsDuringMetadataRefresh({
            pageLabels: ['i'],
            pageLabelsResolved: false,
            isSaving: false,
            totalPages: 3,
        })).toBeNull();
    });

    it('loads labels from document when available', async () => {
        const markDirty = vi.fn();
        const pdfDocument = createPdfDocumentRef(3, async () => [
            'i',
            'ii',
            'iii',
        ]);
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toEqual([
            'i',
            'ii',
            'iii',
        ]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('falls back to default labels when document labels throw', async () => {
        const markDirty = vi.fn();
        const pdfDocument = createPdfDocumentRef(2, async () => {
            throw new Error('bad labels');
        });
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(2),
            markDirty,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('collapses implicit default labels to null when the document exposes numeric labels', async () => {
        const markDirty = vi.fn();
        const pdfDocument = createPdfDocumentRef(3, async () => [
            '1',
            '2',
            '3',
        ]);
        const state = usePageLabelState({
            pdfDocument,
            totalPages: ref(3),
            markDirty,
        });

        await state.syncPageLabelsFromDocument(pdfDocument.value);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
    });

    it('marks dirty only when label ranges actually change', () => {
        const markDirty = vi.fn();
        const onPageLabelsDirty = vi.fn();
        const state = usePageLabelState({
            pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(null)),
            totalPages: ref(5),
            markDirty,
            onPageLabelsDirty,
        });

        const ranges: IPdfPageLabelRange[] = [{
            startPage: 1,
            style: 'D',
            prefix: 'P-',
            startNumber: 1,
        }];

        state.handlePageLabelRangesUpdate(ranges);
        expect(state.pageLabelsDirty.value).toBe(true);
        expect(markDirty).toHaveBeenCalledTimes(1);
        expect(onPageLabelsDirty).toHaveBeenCalledTimes(1);

        markDirty.mockClear();
        onPageLabelsDirty.mockClear();
        state.handlePageLabelRangesUpdate(ranges);
        expect(markDirty).not.toHaveBeenCalled();
        expect(onPageLabelsDirty).not.toHaveBeenCalled();
    });

    it('collapses default numbering edits back to null labels', () => {
        const state = usePageLabelState({
            pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(null)),
            totalPages: ref(4),
            markDirty: vi.fn(),
        });

        state.handlePageLabelRangesUpdate([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('preserves labels while a loaded document is transiently unavailable', async () => {
        const state = usePageLabelState({
            pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(null)),
            totalPages: ref(3),
            markDirty: vi.fn(),
        });

        state.handlePageLabelRangesUpdate([{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }]);
        await state.syncPageLabelsFromDocument(null);

        expect(state.pageLabels.value).toEqual([
            'i',
            'ii',
            'iii',
        ]);
        expect(state.pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('clears labels when no document pages remain', async () => {
        const state = usePageLabelState({
            pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(null)),
            totalPages: ref(0),
            markDirty: vi.fn(),
        });

        state.pageLabels.value = ['i'];
        state.pageLabelRanges.value = [{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }];

        await state.syncPageLabelsFromDocument(null);

        expect(state.pageLabels.value).toBeNull();
        expect(state.pageLabelRanges.value).toEqual([]);
        expect(state.pageLabelsDirty.value).toBe(false);
    });

    it('invokes sync and save callbacks when labels rebaseline', async () => {
        const onPageLabelsSynchronized = vi.fn();
        const onPageLabelsSaved = vi.fn();
        const state = usePageLabelState({
            pdfDocument: cast<Ref<PDFDocumentProxy | null>>(ref(null)),
            totalPages: ref(0),
            markDirty: vi.fn(),
            onPageLabelsSynchronized,
            onPageLabelsSaved,
        });

        await state.syncPageLabelsFromDocument(null);
        state.markPageLabelsSaved();

        expect(onPageLabelsSynchronized).toHaveBeenCalled();
        expect(onPageLabelsSaved).toHaveBeenCalledOnce();
    });
});
