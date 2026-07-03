import type { TDocumentRef } from '@contracts/documentRef';
import { isRecord } from '@contracts/runtimeGuards';

export type TDocumentRevisionToken = string;
export type TDocumentRevisionAuthority = 'electron-working-copy' | 'browser-document-store';

export type TDocumentRevisionChangeReason =
    | 'open'
    | 'write'
    | 'replace-working-copy'
    | 'page-ops'
    | 'ocr-apply'
    | 'save-sync'
    | 'native-mutation'
    | 'browser-handle-refresh'
    | 'unknown';

export interface IDocumentRevisionStamp {token: TDocumentRevisionToken;}

export interface IDocumentRevisionInfo extends IDocumentRevisionStamp {
    version: 1;
    documentRef: TDocumentRef;
    authority: TDocumentRevisionAuthority;
    contentRevision: number;
    mintedAt: number;
}

export interface IDocumentRevisionChangedEvent extends IDocumentRevisionInfo {
    previousToken?: TDocumentRevisionToken;
    reason: TDocumentRevisionChangeReason;
}

export function isDocumentRevisionInfo(value: unknown): value is IDocumentRevisionInfo {
    return isRecord(value)
        && value.version === 1
        && typeof value.token === 'string'
        && value.token.length > 0
        && typeof value.documentRef === 'string'
        && value.documentRef.length > 0
        && (value.authority === 'electron-working-copy' || value.authority === 'browser-document-store')
        && typeof value.contentRevision === 'number'
        && Number.isInteger(value.contentRevision)
        && value.contentRevision >= 0
        && typeof value.mintedAt === 'number'
        && Number.isFinite(value.mintedAt);
}
