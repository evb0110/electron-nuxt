import type {
    IpcMain,
    IpcMainInvokeEvent,
} from 'electron';
import {
    app,
    ipcMain,
} from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { SEARCH_CHANNELS } from '@electron/features/search/contract';
import type { ISearchResponse } from '@electron/features/search/protocol';
import { findWorkingCopyPathByOriginalPath } from '@electron/ipc/workingCopy';
import { createLogger } from '@electron/utils/logger';
import { resolveAllowedReadPath } from '@electron/utils/path-validator';
import {
    getSearchWorkerServiceConfig,
    SearchWorkerService,
} from '@electron/features/search/main/search-worker-service';

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
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

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

    return {
        pdfPath,
        query,
        pageCount,
        requestId,
        matchCase,
        wholeWord,
        useRegex,
    };
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

    return {
        pdfPath,
        pageCount,
        requestId,
    };
}

export function resolveSearchWorkerPath(workerBaseDir = __dirname): string {
    const defaultPath = join(workerBaseDir, 'search-worker.js');
    if (!app?.isPackaged) {
        return defaultPath;
    }

    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

export async function resolveSearchablePdfPath(pdfPath: string): Promise<string | null> {
    if (isWorkingCopyPathCandidate(pdfPath)) {
        const directResolvedPath = await resolveAllowedReadPath(pdfPath);
        if (directResolvedPath) {
            return directResolvedPath;
        }
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(pdfPath);
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

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath);
    if (!resolvedPdfPath) {
        throw new Error('Invalid PDF path: search only allowed within temp directory');
    }

    return searchWorkerService.dispatchSearchRequest(event, {
        resolvedPdfPath,
        query,
        pageCount,
        matchCase,
        wholeWord,
        useRegex,
        requestId: parsedRequest.requestId,
        requestIdPrefix: 'search',
    });
}

async function handlePdfSearchWarmIndex(
    event: IpcMainInvokeEvent,
    request: unknown,
): Promise<boolean> {
    const parsedRequest = parseWarmIndexPayload(request);
    const normalizedPdfPath = parsedRequest.pdfPath.trim();
    if (!normalizedPdfPath) {
        throw new Error('Invalid PDF path');
    }

    const resolvedPdfPath = await resolveSearchablePdfPath(normalizedPdfPath);
    if (!resolvedPdfPath) {
        throw new Error('Invalid PDF path: search only allowed within temp directory');
    }

    await searchWorkerService.dispatchSearchRequest(event, {
        resolvedPdfPath,
        query: '',
        pageCount: parsedRequest.pageCount,
        requestId: parsedRequest.requestId,
        warmup: true,
        requestIdPrefix: 'search-warm',
    });

    return true;
}

function handlePdfSearchCancel(
    event: IpcMainInvokeEvent,
    requestId?: string,
) {
    return searchWorkerService.cancel(event, requestId);
}

interface IIpcMainHandleRegistrar {handle: IpcMain['handle'];}

export function registerSearchHandlers(registrar: IIpcMainHandleRegistrar = ipcMain) {
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
