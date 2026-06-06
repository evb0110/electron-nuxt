import type { TDocumentRef } from '@contracts/platformApi';
import type { IOcrWord } from '@contracts/shared';

export interface IOcrManifest {
    version: number;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, {path: string}>;
}

export interface IOcrPageData {
    pageNumber: number;
    rotation: 0 | 90 | 180 | 270;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
}

export interface IOcrTextContentCacheStats {
    manifestEntries: number;
    pageEntries: number;
    pageBytes: number;
}

export interface IOcrTextContentCacheOptions {
    maxManifestEntries?: number;
    maxPageEntries?: number;
    maxPageBytes?: number;
}

export interface IOcrTextContentCache {
    getManifest(workingCopyPath: TDocumentRef): IOcrManifest | null | undefined;
    setManifest(workingCopyPath: TDocumentRef, manifest: IOcrManifest | null): void;
    getPageData(workingCopyPath: TDocumentRef, pageNumber: number): IOcrPageData | undefined;
    setPageData(workingCopyPath: TDocumentRef, pageNumber: number, pageData: IOcrPageData): void;
    clearCache(workingCopyPath?: TDocumentRef): void;
    getStats(): IOcrTextContentCacheStats;
}
