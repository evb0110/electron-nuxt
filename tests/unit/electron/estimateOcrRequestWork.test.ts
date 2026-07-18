import {
    describe,
    expect,
    it,
} from 'vitest';
import { estimateOcrRequestWork } from '@electron/ocr/estimateOcrRequestWork';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';

function buildPages(count: number): IOcrPdfPageRequest[] {
    return Array.from({length: count}, (_, index) => ({
        pageNumber: index + 1,
        languages: ['eng'],
    }));
}

describe('estimateOcrRequestWork', () => {
    it('reports true page work so admission rejects oversized requests', () => {
        expect(estimateOcrRequestWork(buildPages(5_000), {}).pageWork).toBe(5_000);
    });

    it('weights higher render DPI instead of clamping the result', () => {
        expect(estimateOcrRequestWork(buildPages(100), {renderDpi: 600}).pageWork).toBe(400);
    });
});
