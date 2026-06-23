import { range } from 'es-toolkit/math';
import type { TOcrPageRange } from '@app/utils/ocr/ocrTypes';

export function parsePageRange(
    rangeType: TOcrPageRange,
    customRange: string,
    currentPage: number,
    totalPages: number,
): number[] {
    if (rangeType === 'current') {
        return currentPage >= 1 && currentPage <= totalPages ? [currentPage] : [];
    }

    if (rangeType === 'all') {
        return range(1, totalPages + 1);
    }

    const pages = new Set<number>();
    const parts = customRange.split(',').map(p => p.trim());
    const singlePagePattern = /^\d+$/u;
    const pageRangePattern = /^(\d+)\s*-\s*(\d+)$/u;

    for (const part of parts) {
        const rangeMatch = pageRangePattern.exec(part);
        if (rangeMatch) {
            const start = Number(rangeMatch[1]);
            const end = Number(rangeMatch[2]);
            if (start <= end) {
                range(Math.max(1, start), Math.min(totalPages, end) + 1)
                    .forEach(page => pages.add(page));
            }
            continue;
        }

        if (!singlePagePattern.test(part)) {
            continue;
        }

        const num = Number(part);
        if (num >= 1 && num <= totalPages) {
            pages.add(num);
        }
    }

    return Array.from(pages).sort((a, b) => a - b);
}
