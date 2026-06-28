import { app } from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { ISearchResponse } from '@electron/features/search/protocol';
import {
    type INormalizedPdfSearchRequest,
    type INormalizedPdfSearchWarmIndexRequest,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
} from '@electron/features/search/searchRequestPayload';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import { SearchWorkerService } from '@electron/features/search/main/searchWorkerService';
import { SEARCH_PAGE_COUNT_MAX } from '@electron/features/search/main/searchRequestValidation';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import type {
    ISearchOperationContext,
    ISearchSenderContext,
} from '@electron/features/search/searchService';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
    toSearchIpcError,
} from '@electron/features/search/main/searchErrors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isWorkingCopyPathCandidate(pdfPath: string) {
    return /(?:^|[/\\])pdf-work-[^/\\]+[/\\]/u.test(pdfPath);
}

function parseSearchRequestPayload(raw: unknown): INormalizedPdfSearchRequest {
    try {
        return normalizePdfSearchRequestPayload(raw, {pageCountMax: SEARCH_PAGE_COUNT_MAX});
    } catch (error) {
        throw toSearchIpcError(error, 'SEARCH_INVALID_PAYLOAD');
    }
}

function parseWarmIndexPayload(raw: unknown): INormalizedPdfSearchWarmIndexRequest {
    try {
        return normalizePdfSearchWarmIndexPayload(raw, {pageCountMax: SEARCH_PAGE_COUNT_MAX});
    } catch (error) {
        throw toSearchIpcError(error, 'SEARCH_INVALID_PAYLOAD');
    }
}

export function resolveSearchWorkerPath(workerBaseDir = __dirname) {
    const defaultPath = join(workerBaseDir, WORKER_BUNDLES_BY_ID.search.fileName);
    if (!app?.isPackaged) {
        return defaultPath;
    }
    return resolveUnpackedWorkerPath(workerBaseDir, WORKER_BUNDLES_BY_ID.search.fileName);
}

export async function resolveSearchablePdfPath(pdfPath: string, senderWebContentsId?: number) {
    if (isWorkingCopyPathCandidate(pdfPath)) {
        const directResolvedPath = await resolveAllowedReadPath(pdfPath);
        if (directResolvedPath) {
            return directResolvedPath;
        }
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(pdfPath, senderWebContentsId);
    if (mappedWorkingCopyPath) {
        const mappedResolvedPath = await resolveAllowedReadPath(mappedWorkingCopyPath);
        if (mappedResolvedPath) {
            return mappedResolvedPath;
        }
    }

    const directResolvedPath = await resolveAllowedReadPath(pdfPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    return null;
}

export const searchWorkerService = new SearchWorkerService(resolveSearchWorkerPath);

function normalizeSearchOperationContext(context: ISearchSenderContext): ISearchOperationContext {
    return {
        sender: context.sender,
        senderId: context.senderId ?? context.sender.id,
    };
}

export async function handlePdfSearch(
    context: ISearchSenderContext,
    request: unknown,
): Promise<ISearchResponse> {
    const operationContext = normalizeSearchOperationContext(context);
    const parsedRequest = parseSearchRequestPayload(request);
    const {
        pdfPath,
        query,
        pageCount,
        matchCase,
        wholeWord,
        useRegex,
    } = parsedRequest;

    if (!query || query.trim().length === 0) {
        return {
            results: [],
            truncated: false,
        };
    }

    const normalizedPdfPath = typeof pdfPath === 'string' ? pdfPath.trim() : '';
    if (!normalizedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope('SEARCH_INVALID_PAYLOAD', 'Invalid PDF path'));
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath, operationContext.senderId);
    if (!resolvedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope(
            'SEARCH_PATH_DENIED',
            'Invalid PDF path: search only allowed within temp directory',
        ));
    }

    const dispatchPayload: Parameters<typeof searchWorkerService.dispatchSearchRequest>[1] = {
        resolvedPdfPath,
        query,
        requestIdPrefix: 'search',
    };
    if (pageCount !== undefined) {
        dispatchPayload.pageCount = pageCount;
    }
    if (parsedRequest.requestId !== undefined) {
        dispatchPayload.requestId = parsedRequest.requestId;
    }
    if (matchCase !== undefined) {
        dispatchPayload.matchCase = matchCase;
    }
    if (wholeWord !== undefined) {
        dispatchPayload.wholeWord = wholeWord;
    }
    if (useRegex !== undefined) {
        dispatchPayload.useRegex = useRegex;
    }

    return searchWorkerService.dispatchSearchRequest(operationContext, dispatchPayload);
}

export async function handlePdfSearchWarmIndex(
    context: ISearchSenderContext,
    request: unknown,
) {
    const operationContext = normalizeSearchOperationContext(context);
    const parsedRequest = parseWarmIndexPayload(request);
    const normalizedPdfPath = parsedRequest.pdfPath.trim();
    if (!normalizedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope('SEARCH_INVALID_PAYLOAD', 'Invalid PDF path'));
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath, operationContext.senderId);
    if (!resolvedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope(
            'SEARCH_PATH_DENIED',
            'Invalid PDF path: search only allowed within temp directory',
        ));
    }

    const dispatchPayload: Parameters<typeof searchWorkerService.dispatchSearchRequest>[1] = {
        resolvedPdfPath,
        query: '',
        warmup: true,
        requestIdPrefix: 'search-warm',
    };
    if (parsedRequest.pageCount !== undefined) {
        dispatchPayload.pageCount = parsedRequest.pageCount;
    }
    if (parsedRequest.requestId !== undefined) {
        dispatchPayload.requestId = parsedRequest.requestId;
    }

    await searchWorkerService.dispatchSearchRequest(operationContext, dispatchPayload);

    return true;
}
