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
import { isRecord } from '@contracts/runtimeGuards';
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import { createLogger } from '@electron/utils/createLogger';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {
    getSearchWorkerServiceConfig,
    SearchWorkerService,
} from '@electron/features/search/main/searchWorkerService';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import type { TSearchIpcMainRegistrar } from '@electron/features/search/searchService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createLogger('search-ipc');
let appCleanupRegistered = false;

function isWorkingCopyPathCandidate(pdfPath: string) {
    return /(?:^|[/\\])pdf-work-[^/\\]+[/\\]/u.test(pdfPath);
}

const SEARCH_PAGE_COUNT_MAX = (() => {
    const parsed = Number.parseInt(process.env.EVB_SEARCH_PAGE_COUNT_MAX ?? '20000', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 20_000;
    }
    return Math.min(parsed, 1_000_000);
})();
function parseOptionalPageCount(raw: unknown) {
    if (raw === undefined) {
        return undefined;
    }

    if (
        typeof raw !== 'number'
        || !Number.isSafeInteger(raw)
        || raw < 1
        || raw > SEARCH_PAGE_COUNT_MAX
    ) {
        throw new Error(`Invalid pageCount: must be an integer between 1 and ${SEARCH_PAGE_COUNT_MAX}`);
    }

    return raw;
}

function parseOptionalRequestId(raw: unknown) {
    return typeof raw === 'string' && raw.trim().length > 0
        ? raw.trim()
        : undefined;
}

function parseSearchRequestPayload(raw: unknown): {
    pdfPath: string;
    query: string;
    pageCount?: number;
    requestId?: string;
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
} {
    if (!isRecord(raw)) {
        throw new Error('Invalid search request payload');
    }

    const pdfPath = typeof raw.pdfPath === 'string' ? raw.pdfPath.trim() : '';
    if (!pdfPath) {
        throw new Error('Invalid PDF path');
    }

    if (typeof raw.query !== 'string') {
        throw new Error('Invalid search query');
    }
    const query = raw.query;

    const pageCount = parseOptionalPageCount(raw.pageCount);
    const requestId = parseOptionalRequestId(raw.requestId);
    const matchCase = typeof raw.matchCase === 'boolean' ? raw.matchCase : undefined;
    const wholeWord = typeof raw.wholeWord === 'boolean' ? raw.wholeWord : undefined;
    const useRegex = typeof raw.useRegex === 'boolean' ? raw.useRegex : undefined;

    const parsed: {
        pdfPath: string;
        query: string;
        pageCount?: number;
        requestId?: string;
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    } = {
        pdfPath,
        query,
    };
    if (pageCount !== undefined) {
        parsed.pageCount = pageCount;
    }
    if (requestId !== undefined) {
        parsed.requestId = requestId;
    }
    if (matchCase !== undefined) {
        parsed.matchCase = matchCase;
    }
    if (wholeWord !== undefined) {
        parsed.wholeWord = wholeWord;
    }
    if (useRegex !== undefined) {
        parsed.useRegex = useRegex;
    }
    return parsed;
}

function parseWarmIndexPayload(raw: unknown): {
    pdfPath: string;
    pageCount?: number;
    requestId?: string;
} {
    if (!isRecord(raw)) {
        throw new Error('Invalid warm-index payload');
    }

    const pdfPath = typeof raw.pdfPath === 'string' ? raw.pdfPath.trim() : '';
    if (!pdfPath) {
        throw new Error('Invalid PDF path');
    }

    const pageCount = parseOptionalPageCount(raw.pageCount);
    const requestId = parseOptionalRequestId(raw.requestId);

    const parsed: {
        pdfPath: string;
        pageCount?: number;
        requestId?: string;
    } = {pdfPath};
    if (pageCount !== undefined) {
        parsed.pageCount = pageCount;
    }
    if (requestId !== undefined) {
        parsed.requestId = requestId;
    }
    return parsed;
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
        throw new Error('Invalid PDF path');
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath, event.sender?.id);
    if (!resolvedPdfPath) {
        throw new Error('Invalid PDF path: search only allowed within temp directory');
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
        throw new Error('Invalid PDF path');
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath, event.sender?.id);
    if (!resolvedPdfPath) {
        throw new Error('Invalid PDF path: search only allowed within temp directory');
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

function handlePdfSearchCancel(
    event: IpcMainInvokeEvent,
    requestId?: string,
) {
    return searchWorkerService.cancel(event, requestId);
}

export function registerSearchHandlers(registrar: TSearchIpcMainRegistrar = ipcMain) {
    const serviceConfig = getSearchWorkerServiceConfig();
    log.info(
        'Registering search IPC handlers '
        + `(requestTimeoutMs=${serviceConfig.requestTimeoutMs}, idleTtlMs=${serviceConfig.idleTtlMs}, maxActive=${serviceConfig.maxActive})`,
    );
    registrar.handle(SEARCH_CHANNELS.search, handlePdfSearch);
    registrar.handle(SEARCH_CHANNELS.warmIndex, handlePdfSearchWarmIndex);
    registrar.handle(SEARCH_CHANNELS.cancel, handlePdfSearchCancel);
    registrar.handle(SEARCH_CHANNELS.resetCache, () => searchWorkerService.resetCache());

    if (!appCleanupRegistered) {
        appCleanupRegistered = true;
        app.on('before-quit', () => {
            searchWorkerService.cleanupAll('App shutting down');
        });
    }
}
