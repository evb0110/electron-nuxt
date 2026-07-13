import type { TPdfViewMode } from '@contracts/shared';
import { stepBySpread } from '@app/utils/pdfViewMode';

export interface IPdfPageDropdownDisplayPageOptions {
    currentPage: number;
    navigationPage?: number | undefined;
    totalPages: number;
}

export interface IPdfPageDropdownIndicatorOptions {
    page: number;
    pageLabels: string[] | null;
    totalPages: number;
}

function normalizePdfPageDropdownPage(page: number, totalPages: number) {
    if (!Number.isFinite(page)) {
        return 1;
    }
    if (totalPages <= 0) {
        return Math.max(Math.trunc(page), 1);
    }
    const maxPage = Number.isFinite(totalPages)
        ? Math.max(Math.trunc(totalPages), 1)
        : 1;

    return Math.min(Math.max(Math.trunc(page), 1), maxPage);
}

export function stepPdfPageDropdownCommand(
    page: number,
    viewMode: TPdfViewMode,
    totalPages: number,
    direction: -1 | 1,
) {
    return stepBySpread(
        Math.max(1, Math.trunc(page)),
        viewMode,
        totalPages > 0 ? totalPages : Number.MAX_SAFE_INTEGER,
        direction,
    );
}

export function resolvePdfPageDropdownDisplayPage(options: IPdfPageDropdownDisplayPageOptions) {
    const page = typeof options.navigationPage === 'number' && Number.isFinite(options.navigationPage)
        ? options.navigationPage
        : options.currentPage;

    return normalizePdfPageDropdownPage(page, options.totalPages);
}

export function getPdfPageDropdownInputLabel(page: number, pageLabels: string[] | null) {
    const label = pageLabels?.[page - 1] ?? '';
    return label.trim() || page.toString();
}

export function getPdfPageDropdownIndicatorParts(options: IPdfPageDropdownIndicatorOptions) {
    if (options.totalPages <= 0) {
        return {
            primary: '-',
            secondary: '',
        };
    }

    const page = normalizePdfPageDropdownPage(options.page, options.totalPages);
    const logical = options.pageLabels?.[page - 1]?.trim() ?? '';
    if (!logical || logical === String(page)) {
        return {
            primary: String(page),
            secondary: '',
        };
    }

    return {
        primary: logical,
        secondary: `(${page})`,
    };
}
