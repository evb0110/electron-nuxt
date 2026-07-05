export interface IPdfBookmarkEntry {
    title: string;
    pageIndex: number | null;
    pageYRatio?: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: IPdfBookmarkEntry[];
}
