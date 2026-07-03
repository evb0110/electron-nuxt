import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
} from '@contracts/ocrIndex';

export type IOcrManifest = IOcrIndexV3Manifest;
export type IOcrPageData = IOcrIndexV3Page;

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
    getManifest(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken): IOcrManifest | null | undefined;
    setManifest(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken, manifest: IOcrManifest | null): void;
    getPageData(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken, pageNumber: number): IOcrPageData | undefined;
    setPageData(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken, pageNumber: number, pageData: IOcrPageData): void;
    clearCache(workingCopyPath?: TDocumentRef): void;
    getStats(): IOcrTextContentCacheStats;
}
