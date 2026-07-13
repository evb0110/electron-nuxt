import type { TDocumentRef } from '@contracts/documentRef';

export type TDocumentPageSourceKind = 'pdf' | 'djvu';
export type TDocumentRenderPriority = 'navigation' | 'visible' | 'nearby' | 'thumbnail' | 'prefetch';

export interface IDocumentPageMetrics {
    /** Page width in PDF points (1/72 inch). */
    widthPoints: number;
    /** Page height in PDF points (1/72 inch). */
    heightPoints: number;
    rotation: 0 | 90 | 180 | 270;
}

export interface IDocumentSurfaceLease {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly bytes: number;
    readonly surface: HTMLCanvasElement | string;
    onInvalidated?(listener: () => void): () => void;
    promotePriority?(priority: TDocumentRenderPriority): void;
    release(): void;
}

export interface IDocumentPageRenderRequest {
    pageNumber: number;
    widthPx: number;
    priority: TDocumentRenderPriority;
    signal: AbortSignal;
}

export interface IDocumentTextProvider {getPageText(pageNumber: number, signal: AbortSignal): Promise<string>;}

export interface IDocumentOutlineItem {
    title: string;
    pageNumber: number | null;
    children: IDocumentOutlineItem[];
}

export interface IDocumentOutlineProvider {getOutline(signal: AbortSignal): Promise<IDocumentOutlineItem[]>;}

export interface IDocumentThumbnailProvider {renderThumbnail(request: IDocumentPageRenderRequest): Promise<IDocumentSurfaceLease>;}

export interface IDocumentRasterProvider {renderRaster(request: IDocumentPageRenderRequest): Promise<IDocumentSurfaceLease>;}

export interface IDocumentAnnotationRecord {
    id: string;
    pageNumber: number;
    payload: Readonly<Record<string, unknown>>;
}

export interface IDocumentAnnotationProvider {
    getPageAnnotations(pageNumber: number): readonly IDocumentAnnotationRecord[];
    upsert(annotation: IDocumentAnnotationRecord): void;
    remove(annotationId: string): boolean;
}

export interface IDocumentPageSource {
    readonly kind: TDocumentPageSourceKind;
    readonly documentRef: TDocumentRef;
    readonly pageCount: number;
    readonly textProvider?: IDocumentTextProvider | undefined;
    readonly outlineProvider?: IDocumentOutlineProvider | undefined;
    readonly thumbnailProvider?: IDocumentThumbnailProvider | undefined;
    readonly rasterProvider?: IDocumentRasterProvider | undefined;
    readonly annotationProvider?: IDocumentAnnotationProvider | undefined;
    getPageMetrics(pageNumber: number, signal?: AbortSignal): Promise<IDocumentPageMetrics>;
    renderPage(request: IDocumentPageRenderRequest): Promise<IDocumentSurfaceLease>;
    dispose(): void;
}

export interface IDocumentSourceCapabilities {
    annotations: boolean;
    directImageExport: boolean;
    outline: boolean;
    pageEdits: boolean;
    search: boolean;
    text: boolean;
}

export function assertDocumentPageNumber(pageNumber: number, pageCount: number) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
        throw new RangeError(`Document page ${pageNumber} is outside 1..${pageCount}`);
    }
}
