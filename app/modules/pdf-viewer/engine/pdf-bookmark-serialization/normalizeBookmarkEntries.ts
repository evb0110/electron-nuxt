import { clamp } from 'es-toolkit/math';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';

export function normalizeBookmarkEntries(
    entries: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
): IPdfBookmarkEntry[] {
    if (totalPages <= 0) {
        return [];
    }

    const maxPageIndex = totalPages - 1;

    function normalizeItem(item: IPdfBookmarkEntry): IPdfBookmarkEntry {
        const title = item.title.trim();
        const pageIndex = typeof item.pageIndex === 'number'
            ? clamp(Math.trunc(item.pageIndex), 0, maxPageIndex)
            : null;
        const namedDest = typeof item.namedDest === 'string' && item.namedDest.trim().length > 0
            ? item.namedDest
            : null;
        const bold = item.bold === true;
        const italic = item.italic === true;
        const color = normalizeBookmarkColor(item.color);

        return {
            title: title.length > 0 ? title : untitledLabel,
            pageIndex,
            namedDest,
            bold,
            italic,
            color,
            items: item.items.map(normalizeItem),
        };
    }

    return entries.map(normalizeItem);
}
