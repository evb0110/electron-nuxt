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
}

export interface IPagePreviewRenderedObjectUrl {
    objectUrl: string;
    renderedPx: number;
}

export interface IPagePreviewSource {
    cancelPagePreview?(pageNumber: number): void;
    getPageSizes(): Promise<IPreviewPageSize[]>;
    renderPageObjectUrl(
        pageNumber: number,
        options?: unknown,
    ): Promise<IPagePreviewRenderedObjectUrl>;
    revokeObjectURL(url: string): void;
    terminate(): void;
}
