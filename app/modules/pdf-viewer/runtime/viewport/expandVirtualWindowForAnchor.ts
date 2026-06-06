import { clamp } from 'es-toolkit/math';

export function expandVirtualWindowForAnchor(options: {
    baseStart: number;
    baseEnd: number;
    anchorPage: number | null;
    totalPages: number;
    buffer: number;
}) {
    const baseStart = Math.max(1, Math.trunc(options.baseStart));
    const baseEnd = Math.max(baseStart, Math.trunc(options.baseEnd));
    const totalPages = Math.max(baseEnd, Math.trunc(options.totalPages));
    const anchorPage = typeof options.anchorPage === 'number' && Number.isFinite(options.anchorPage)
        ? clamp(Math.trunc(options.anchorPage), 1, totalPages)
        : null;
    if (anchorPage === null) {
        return {
            start: baseStart,
            end: Math.min(totalPages, baseEnd),
        };
    }

    const buffer = Math.max(0, Math.trunc(options.buffer));
    return {
        start: clamp(anchorPage - buffer, 1, baseStart),
        end: clamp(anchorPage + buffer, baseEnd, totalPages),
    };
}
