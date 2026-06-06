import { range } from 'es-toolkit/math';
import type { TOcrPageRange } from '@app/utils/ocr/ocrTypes';

export function parsePageRange(
    rangeType: TOcrPageRange,
    customRange: string,
    currentPage: number,
    totalPages: number,
): number[] {
    if (rangeType === 'current') {
        return [currentPage];
    }

    if (rangeType === 'all') {
        return range(1, totalPages + 1);
    }

    const pages = new Set<number>();
    const parts = customRange.split(',').map(p => p.trim());

    for (const part of parts) {
        if (part.includes('-')) {
            const segments = part.split('-');
            const startStr = segments[0];
            const endStr = segments[1];
            if (startStr && endStr) {
                const start = parseInt(startStr.trim(), 10);
                const end = parseInt(endStr.trim(), 10);
                if (!isNaN(start) && !isNaN(end)) {
                    range(Math.max(1, start), Math.min(totalPages, end) + 1)
                        .forEach(page => pages.add(page));
                }
            }
        } else {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= totalPages) {
                pages.add(num);
            }
        }
    }

    return Array.from(pages).sort((a, b) => a - b);
}
