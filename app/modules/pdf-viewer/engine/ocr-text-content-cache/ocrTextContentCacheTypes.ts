import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
} from '@contracts/ocrIndex';

export type IOcrManifest = IOcrIndexV2Manifest;
export type IOcrPageData = IOcrIndexV2Page;

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
