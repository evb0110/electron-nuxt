export interface IDocumentPreviewPageState {
    failedRenderPx: number;
    objectUrl: string | null;
    renderedPx: number;
    status: 'idle' | 'loading' | 'loaded' | 'error';
    token: number;
}

export interface IPreviewPageSize {
    width: number;
    height: number;
    dpi?: number | undefined;
}

export interface IPagePreviewSourceInfo {
    pageCount: number;
    pageNumber: number;
    pageSize: IPreviewPageSize;
}

export interface IPagePreviewRenderedObjectUrl {
    objectUrl: string;
    renderedPx: number;
    onInvalidated?: (listener: () => void) => () => void;
    promotePriority?: (priority: number) => void;
}

export interface IPagePreviewOutlineItem {
    title: string;
    pageNumber: number | null;
    children: IPagePreviewOutlineItem[];
}

export interface IPagePreviewSource {
    cancelPagePreview?(pageNumber: number): void;
    getPageSizes(): Promise<IPreviewPageSize[]>;
    getPageSize?(pageNumber: number): Promise<IPreviewPageSize>;
    getPageSourceInfo?(pageNumber: number): Promise<IPagePreviewSourceInfo>;
    getPageText?(pageNumber: number): Promise<string>;
    getOutline?(): Promise<IPagePreviewOutlineItem[]>;
    renderPageObjectUrl(
        pageNumber: number,
        options?: unknown,
    ): Promise<IPagePreviewRenderedObjectUrl>;
    revokeObjectURL(url: string): void;
    terminate(): void;
}
