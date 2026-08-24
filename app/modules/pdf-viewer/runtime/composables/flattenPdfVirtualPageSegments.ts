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
    const items: TPdfVirtualPageItem[] = [];
    // The call-local ordinal keeps each structural spacer stable across
    // projections with the same segment order. It is not a global counter.
    let spacerIndex = 0;
    for (const segment of segments) {
        const pages: TPdfVirtualPageItem[] = segment.pages.map(page => ({
            key: `page:${page}`,
            kind: 'page',
            page,
        }));
        if (!segment.spacerBeforeStyle) {
            items.push(...pages);
            continue;
        }
        items.push(
            {
                // Keep the structural spacer node stable while its height and
                // page window move. Replacing it lets the browser observe a
                // transiently shortened scroll tree and clamp scrollTop before
                // the new far-window spacer is inserted.
                key: `spacer:${spacerIndex++}`,
                kind: 'spacer',
                style: segment.spacerBeforeStyle,
            },
            ...pages,
        );
    }
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
