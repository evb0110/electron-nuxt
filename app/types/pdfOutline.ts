import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';

export type TBookmarkDisplayMode = 'top-level' | 'all-expanded' | 'current-expanded';
export type TBookmarkDropPosition = 'before' | 'after' | 'child';

type TBookmarkContractCore = Pick<
    IPdfBookmarkEntry,
    | 'title'
    | 'pageIndex'
    | 'bold'
    | 'italic'
    | 'color'
>;

export interface IBookmarkItem extends TBookmarkContractCore {
    dest: string | unknown[] | null;
    id: string;
    items: IBookmarkItem[];
}

export interface IBookmarkLocation {
    parent: IBookmarkItem | null;
    list: IBookmarkItem[];
    index: number;
    item: IBookmarkItem;
}

export interface IBookmarkMenuPayload {
    id: string;
    x: number;
    y: number;
}

export interface IBookmarkDropTarget {
    id: string;
    position: TBookmarkDropPosition;
}

export interface IBookmarkActivatePayload {
    id: string;
    hasChildren: boolean;
    wasActive: boolean;
    multiSelect: boolean;
    rangeSelect: boolean;
}

export interface IBookmarkDropPayload {
    targetId: string;
    position: TBookmarkDropPosition;
}
