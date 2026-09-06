import type { TPageIndex } from '@contracts/pageNumbers';

export interface IPdfBookmarkEntry {
    readonly title: string;
    readonly pageIndex: TPageIndex | null;
    readonly pageYRatio?: number | null;
    readonly namedDest: string | null;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly color: string | null;
    readonly items: readonly IPdfBookmarkEntry[];
}
