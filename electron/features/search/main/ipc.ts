import { app } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { ISearchResponse } from '@electron/features/search/protocol';
import type {
    INormalizedPdfSearchRequest,
    INormalizedPdfSearchWarmIndexRequest,
} from '@electron/features/search/searchRequestPayload';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {
    getSearchWorkerServiceConfig,
    SearchWorkerService,
    type ISearchOperationContext,
    type ISearchSenderContext,
} from '@electron/features/search/main/searchWorkerService';
import { SEARCH_PAGE_COUNT_MAX } from '@electron/features/search/main/searchRequestValidation';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
} from '@electron/features/search/main/searchErrors';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { createLogger } from '@electron/utils/createLogger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isWorkingCopyPathCandidate(pdfPath: string) {
    return /(?:^|[/\\])pdf-work-[^/\\]+[/\\]/u.test(pdfPath);
}

function assertSearchPageCountPolicy(pageCount: number | undefined) {
    if (pageCount !== undefined && pageCount > SEARCH_PAGE_COUNT_MAX) {
        throw new SearchIpcError(buildSearchErrorEnvelope(
            'SEARCH_INVALID_PAYLOAD',
            `Invalid pageCount: must be an integer between 1 and ${SEARCH_PAGE_COUNT_MAX}`,
        ));
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
const log = createLogger('search-ipc');
let appCleanupRegistered = false;

function normalizeSearchOperationContext(context: ISearchSenderContext): ISearchOperationContext {
    return {
        sender: context.sender,
        senderId: context.senderId ?? context.sender.id,
    };
}

async function resolveSearchDocumentRevision(
    resolvedPdfPath: string,
    parsedDocumentRevision: TDocumentRevisionToken | undefined,
    senderId: number,
) {
    return parsedDocumentRevision ?? (await getWorkingCopyRevision(resolvedPdfPath, senderId)).token;
}

export async function handlePdfSearch(
    context: ISearchSenderContext,
    request: INormalizedPdfSearchRequest,
): Promise<ISearchResponse> {
    const operationContext = normalizeSearchOperationContext(context);
    assertSearchPageCountPolicy(request.pageCount);
    const {
        pdfPath,
        query,
        pageCount,
        matchCase,
        wholeWord,
        useRegex,
    } = request;

    if (!query || query.trim().length === 0) {
        return {
            results: [],
            truncated: false,
        };
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(pdfPath, operationContext.senderId);
    if (!resolvedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope(
            'SEARCH_PATH_DENIED',
            'Invalid PDF path: search only allowed within temp directory',
        ));
    }

    const dispatchPayload: Parameters<typeof searchWorkerService.dispatchSearchRequest>[1] = {
        resolvedPdfPath,
        documentRevision: await resolveSearchDocumentRevision(resolvedPdfPath, request.documentRevision, operationContext.senderId),
        query,
        requestIdPrefix: 'search',
    };
    if (pageCount !== undefined) {
        dispatchPayload.pageCount = pageCount;
    }
    if (request.requestId !== undefined) {
        dispatchPayload.requestId = request.requestId;
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
    request: INormalizedPdfSearchWarmIndexRequest,
) {
    const operationContext = normalizeSearchOperationContext(context);
    assertSearchPageCountPolicy(request.pageCount);

    const resolvedPdfPath = await resolveSearchablePdfPath(request.pdfPath, operationContext.senderId);
    if (!resolvedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope(
            'SEARCH_PATH_DENIED',
            'Invalid PDF path: search only allowed within temp directory',
        ));
    }

    const dispatchPayload: Parameters<typeof searchWorkerService.dispatchSearchRequest>[1] = {
        resolvedPdfPath,
        documentRevision: await resolveSearchDocumentRevision(resolvedPdfPath, request.documentRevision, operationContext.senderId),
        query: '',
        warmup: true,
        requestIdPrefix: 'search-warm',
    };
    if (request.pageCount !== undefined) {
        dispatchPayload.pageCount = request.pageCount;
    }
    if (request.requestId !== undefined) {
        dispatchPayload.requestId = request.requestId;
    }

    await searchWorkerService.dispatchSearchRequest(operationContext, dispatchPayload);

    return true;
}

export const searchMainBindings = {
    run: handlePdfSearch,
    warmIndex: handlePdfSearchWarmIndex,
    cancel: (context, requestId) => searchWorkerService.cancel(context, requestId),
    resetCache: () => searchWorkerService.resetCache(),
    subscribeProgress: context => searchWorkerService.subscribeProgress(context),
} satisfies TFeatureMainBindings<typeof SEARCH_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export function prepareSearchMainBindings() {
    const serviceConfig = getSearchWorkerServiceConfig();
    log.info(
        'Registering search IPC handlers '
        + `(requestTimeoutMs=${serviceConfig.requestTimeoutMs}, idleTtlMs=${serviceConfig.idleTtlMs}, maxActive=${serviceConfig.maxActive})`,
    );
    if (!appCleanupRegistered) {
        appCleanupRegistered = true;
        app.on('before-quit', () => {
            searchWorkerService.cleanupAll('App shutting down');
        });
    }
    return searchMainBindings;
}
