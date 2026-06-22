import type { IpcMainInvokeEvent } from 'electron';
import {
    app,
    ipcMain,
} from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { SEARCH_CHANNELS } from '@electron/features/search/contract';
import type { ISearchResponse } from '@electron/features/search/protocol';
import {
    type INormalizedPdfSearchRequest,
    type INormalizedPdfSearchWarmIndexRequest,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
} from '@contracts/search';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import { createLogger } from '@electron/utils/createLogger';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {
    getSearchWorkerServiceConfig,
    SearchWorkerService,
} from '@electron/features/search/main/searchWorkerService';
import { SEARCH_PAGE_COUNT_MAX } from '@electron/features/search/main/searchRequestValidation';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import type { TSearchIpcMainRegistrar } from '@electron/features/search/searchService';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
    toSearchIpcError,
} from '@electron/features/search/main/searchErrors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createLogger('search-ipc');
let appCleanupRegistered = false;

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

const searchWorkerService = new SearchWorkerService(resolveSearchWorkerPath);

async function handlePdfSearch(
    event: IpcMainInvokeEvent,
    request: unknown,
): Promise<ISearchResponse> {
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

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath, event.sender?.id);
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

    return searchWorkerService.dispatchSearchRequest(event, dispatchPayload);
}

async function handlePdfSearchWarmIndex(
    event: IpcMainInvokeEvent,
    request: unknown,
) {
    const parsedRequest = parseWarmIndexPayload(request);
    const normalizedPdfPath = parsedRequest.pdfPath.trim();
    if (!normalizedPdfPath) {
        throw new SearchIpcError(buildSearchErrorEnvelope('SEARCH_INVALID_PAYLOAD', 'Invalid PDF path'));
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath, event.sender?.id);
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

    await searchWorkerService.dispatchSearchRequest(event, dispatchPayload);

    return true;
}

export function registerSearchHandlers(registrar: TSearchIpcMainRegistrar = ipcMain) {
    const serviceConfig = getSearchWorkerServiceConfig();
    log.info(
        'Registering search IPC handlers '
        + `(requestTimeoutMs=${serviceConfig.requestTimeoutMs}, idleTtlMs=${serviceConfig.idleTtlMs}, maxActive=${serviceConfig.maxActive})`,
    );
    registrar.handle(SEARCH_CHANNELS.search, handlePdfSearch);
    registrar.handle(SEARCH_CHANNELS.warmIndex, handlePdfSearchWarmIndex);
    registrar.handle(SEARCH_CHANNELS.cancel, (event, requestId?: unknown) =>
        searchWorkerService.cancel(event, requestId),
    );
    registrar.handle(SEARCH_CHANNELS.resetCache, () => searchWorkerService.resetCache());

    if (!appCleanupRegistered) {
        appCleanupRegistered = true;
        app.on('before-quit', () => {
            searchWorkerService.cleanupAll('App shutting down');
        });
    }
}
