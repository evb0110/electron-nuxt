import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export type TPageOpsRotationAngle = 90 | 180 | 270;

export interface IPageOpsMetadataSnapshot {
    pageLabels: string[] | null;
    bookmarks: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
}

export interface IPageOpsMutationOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
}

export interface IPageIdentityDelta {
    previousPageCount: number;
    pages: Array<{fromPageNumber: number} | {insertedId: string}>;
}

export interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
    documentRevision?: IDocumentRevisionInfo;
    pageIdentityDelta?: IPageIdentityDelta;
}

export interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: TDocumentRef;
}

export interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
    documentRevision?: IDocumentRevisionInfo;
    pageIdentityDelta?: IPageIdentityDelta;
}
