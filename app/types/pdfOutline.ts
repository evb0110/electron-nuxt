import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { TDocumentBookmarkDisplayMode } from '@app/utils/document-viewer/bookmarks/documentBookmarks';

export type TBookmarkDisplayMode = TDocumentBookmarkDisplayMode;
export type TBookmarkDropPosition = 'before' | 'after' | 'child';

type TBookmarkContractCore = Pick<
    IPdfBookmarkEntry,
    | 'title'
    | 'pageIndex'
    | 'pageYRatio'
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
