export type TPdfPagePreviewSource = ImageBitmap | HTMLCanvasElement;

export interface IPdfPagePreviewEntry {
    id: number;
    pageNumber: number;
    source: TPdfPagePreviewSource;
    width: number;
    height: number;
    generation: number;
}
