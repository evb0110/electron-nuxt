import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    ISearchWorkerRequest,
    TSearchWorkerInboundMessage,
} from '@electron/search/protocol';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';

function parseSearchWorkerRequest(value: unknown): ISearchWorkerRequest | null {
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        typeof value.requestId !== 'string'
        || value.requestId.trim().length === 0
        || typeof value.pdfPath !== 'string'
        || value.pdfPath.trim().length === 0
        || documentRevision === null
        || typeof value.query !== 'string'
        || (value.pageCount !== undefined && (
            !isFiniteWorkerMessageNumber(value.pageCount)
            || !Number.isSafeInteger(value.pageCount)
            || value.pageCount < 1
        ))
        || (value.warmup !== undefined && typeof value.warmup !== 'boolean')
        || (value.matchCase !== undefined && typeof value.matchCase !== 'boolean')
        || (value.wholeWord !== undefined && typeof value.wholeWord !== 'boolean')
        || (value.useRegex !== undefined && typeof value.useRegex !== 'boolean')
    ) {
        return null;
    }
    const pageCount = isFiniteWorkerMessageNumber(value.pageCount) ? value.pageCount : undefined;
    const warmup = typeof value.warmup === 'boolean' ? value.warmup : undefined;
    const matchCase = typeof value.matchCase === 'boolean' ? value.matchCase : undefined;
    const wholeWord = typeof value.wholeWord === 'boolean' ? value.wholeWord : undefined;
    const useRegex = typeof value.useRegex === 'boolean' ? value.useRegex : undefined;
    return {
        requestId: value.requestId,
        pdfPath: value.pdfPath,
        documentRevision,
        query: value.query,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(warmup === undefined ? {} : {warmup}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

export function parseSearchWorkerInboundMessage(value: unknown): TSearchWorkerInboundMessage | null {
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'cancel':
            return typeof value.requestId === 'string' && value.requestId.trim().length > 0
                ? {
                    type: 'cancel',
                    requestId: value.requestId,
                }
                : null;
        case 'reset-cache':
            return {type: 'reset-cache'};
        case 'reset-state':
            return {type: 'reset-state'};
        case 'search': {
            const payload = parseSearchWorkerRequest(value.payload);
            return payload
                ? {
                    type: 'search',
                    payload,
                }
                : null;
        }
        default:
            return null;
    }
}
