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

const DOCUMENT_REVISION_CHANGE_REASONS = new Set<TDocumentRevisionChangeReason>([
    'open',
    'write',
    'replace-working-copy',
    'page-ops',
    'ocr-apply',
    'save-sync',
    'native-mutation',
    'browser-handle-refresh',
    'unknown',
]);
const DOCUMENT_REVISION_TOKEN_MAX_LENGTH = 512;
const DOCUMENT_REVISION_REF_MAX_LENGTH = 32_768;

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
        && value.token.length <= DOCUMENT_REVISION_TOKEN_MAX_LENGTH
        && typeof value.documentRef === 'string'
        && value.documentRef.length > 0
        && value.documentRef.length <= DOCUMENT_REVISION_REF_MAX_LENGTH
        && (value.authority === 'electron-working-copy' || value.authority === 'browser-document-store')
        && typeof value.contentRevision === 'number'
        && Number.isSafeInteger(value.contentRevision)
        && value.contentRevision >= 0
        && typeof value.mintedAt === 'number'
        && Number.isSafeInteger(value.mintedAt)
        && value.mintedAt > 0;
}

export function decodeDocumentRevisionChangedEvent(value: unknown): IDocumentRevisionChangedEvent | null {
    const candidate = isRecord(value) ? value : null;
    if (
        candidate === null
        || !isDocumentRevisionInfo(candidate)
        || typeof candidate.reason !== 'string'
        || !DOCUMENT_REVISION_CHANGE_REASONS.has(candidate.reason as TDocumentRevisionChangeReason)
        || (candidate.previousToken !== undefined && (
            typeof candidate.previousToken !== 'string'
            || candidate.previousToken.length === 0
            || candidate.previousToken.length > DOCUMENT_REVISION_TOKEN_MAX_LENGTH
        ))
    ) {
        return null;
    }
    return {
        version: candidate.version,
        token: candidate.token,
        documentRef: candidate.documentRef,
        authority: candidate.authority,
        contentRevision: candidate.contentRevision,
        mintedAt: candidate.mintedAt,
        reason: candidate.reason as TDocumentRevisionChangeReason,
        ...(candidate.previousToken === undefined ? {} : {previousToken: candidate.previousToken}),
    };
}
