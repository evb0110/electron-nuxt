import type { IPdfVirtualPageSegment } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';

export type TPdfVirtualPageItem = {
    key: `page:${number}`;
    kind: 'page';
    page: number;
} | {
    key: `spacer:${number}`;
    kind: 'spacer';
    style: Record<string, string>;
};

/**
 * Keeps pages as globally keyed siblings so a virtual-window boundary change
 * cannot remount an overlapping page and discard its freshly rendered canvas.
 */
export function flattenPdfVirtualPageSegments(
    segments: readonly IPdfVirtualPageSegment[],
    options: {
        initialPageShell?: boolean;
        initialPageShellPage?: number;
    } = {},
): TPdfVirtualPageItem[] {
    const items: TPdfVirtualPageItem[] = segments.flatMap((segment): TPdfVirtualPageItem[] => {
        const pages: TPdfVirtualPageItem[] = segment.pages.map(page => ({
            key: `page:${page}`,
            kind: 'page',
            page,
        }));
        if (!segment.spacerBeforeStyle) {
            return pages;
        }
        return [
            {
                key: `spacer:${segment.start}`,
                kind: 'spacer',
                style: segment.spacerBeforeStyle,
            },
            ...pages,
        ];
    });
    if (items.length > 0 || options.initialPageShell !== true) {
        return items;
    }
    const page = Math.max(1, Math.trunc(options.initialPageShellPage ?? 1));
    return [{
        key: `page:${page}`,
        kind: 'page',
        page,
    }];
}
