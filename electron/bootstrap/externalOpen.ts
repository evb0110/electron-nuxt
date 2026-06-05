import { extname } from 'path';
import { fileURLToPath } from 'url';
import { uniq } from 'es-toolkit/array';
import { getErrorMessage } from '@electron/utils/error';

const SUPPORTED_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
]);

const EXTERNAL_OPEN_BATCH_WINDOW_MS = 800;
const EXTERNAL_OPEN_MAX_BATCH_WAIT_MS = 10_000;
const EXTERNAL_OPEN_RETRY_DISPATCH_MS = 1_000;
const EXTERNAL_OPEN_STARTUP_EMPTY_CLAIM_GRACE_MS = 300;
const EXTERNAL_OPEN_PENDING_MAX_PATHS = (() => {
    const parsed = Number.parseInt(process.env.EVB_EXTERNAL_OPEN_PENDING_MAX_PATHS ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 8) {
        return 256;
    }
    return Math.min(parsed, 4_096);
})();

interface ILogger {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
    error(message: string): void;
}

interface IExternalOpenManagerSink {
    queueOpenRequest(paths: string[]): void;
    requestMainWindowForExternalOpen(): void;
}

interface IWindowLike {
    isMinimized(): boolean;
    restore(): void;
    focus(): void;
}

interface ICreateExternalOpenManagerOptions {
    logger: ILogger;
    noFocus: boolean;
    logStartupPhase: (phase: string) => void;
    isMainWindowRendererReady: () => boolean;
    getMainWindow: () => IWindowLike | null;
    hasWindows: () => boolean;
    createWindow: () => Promise<unknown>;
    grantOpenPaths?: (paths: string[]) => void;
    dispatchOpenPaths: (paths: string[]) => boolean;
}

function isSupportedExternalOpenPath(filePath: string) {
    return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function createMacOpenFileRouter(options: { logger: ILogger; }) {
    const pendingPaths: string[] = [];
    let externalOpenManager: IExternalOpenManagerSink | null = null;

    function handleOpenFile(filePath: string) {
        const normalizedPath = filePath.trim();
        if (!normalizedPath) {
            options.logger.warn('Ignoring empty macOS open-file path');
            return;
        }

        if (!isSupportedExternalOpenPath(normalizedPath)) {
            options.logger.warn(`Ignoring unsupported macOS open-file path: ${normalizedPath}`);
            return;
        }

        if (!externalOpenManager) {
            pendingPaths.push(normalizedPath);
            options.logger.debug(`Buffered macOS open-file path before external open manager init: ${normalizedPath}`);
            return;
        }

        externalOpenManager.queueOpenRequest([normalizedPath]);
        externalOpenManager.requestMainWindowForExternalOpen();
    }

    function attachExternalOpenManager(manager: IExternalOpenManagerSink) {
        externalOpenManager = manager;

        if (pendingPaths.length === 0) {
            return;
        }

        const bufferedPaths = pendingPaths.splice(0, pendingPaths.length);
        options.logger.info(`Flushing ${bufferedPaths.length} early macOS open-file path(s)`);
        externalOpenManager.queueOpenRequest(bufferedPaths);
        externalOpenManager.requestMainWindowForExternalOpen();
    }

    return {
        attachExternalOpenManager,
        handleOpenFile,
    };
}

export function createExternalOpenManager(options: ICreateExternalOpenManagerOptions) {
    const pendingExternalOpenPaths: string[] = [];
    const pendingExternalOpenPathSet = new Set<string>();
    let flushPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
    let retryPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
    let batchWindowStartTime: number | null = null;
    let externalOpenBootstrapReady = false;
    let ensureWindowForExternalOpenPromise: Promise<void> | null = null;
    let hasHandledInitialExternalOpenDispatch = false;
    let pendingFlushRequested = false;
    let startupEmptyClaimGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let startupEmptyClaimGraceResolve: (() => void) | null = null;
    let startupEmptyClaimGracePromise: Promise<void> | null = null;

    function isSupportedFile(filePath: string) {
        return isSupportedExternalOpenPath(filePath);
    }

    function normalizeCommandLineArg(arg: string) {
        let normalized = arg.trim();
        if (!normalized || normalized.startsWith('-')) {
            return null;
        }

        if (
            (normalized.startsWith('"') && normalized.endsWith('"'))
            || (normalized.startsWith('\'') && normalized.endsWith('\''))
        ) {
            normalized = normalized.slice(1, -1);
        }

        if (!normalized) {
            return null;
        }

        if (process.platform === 'win32' && normalized.startsWith('/')) {
            return null;
        }

        if (normalized.startsWith('file://')) {
            try {
                return fileURLToPath(normalized);
            } catch {
                return null;
            }
        }

        return normalized;
    }

    function findJoinedSupportedPath(args: string[], startIndex: number, firstToken: string) {
        let candidate = firstToken;
        for (let cursor = startIndex + 1; cursor < args.length && cursor <= startIndex + 7; cursor += 1) {
            const nextToken = normalizeCommandLineArg(args[cursor] ?? '');
            if (!nextToken) {
                break;
            }
            candidate = `${candidate} ${nextToken}`;
            if (isSupportedFile(candidate)) {
                return {
                    path: candidate,
                    endIndex: cursor,
                };
            }
        }

        return null;
    }

    function collectSupportedPathsFromArgs(args: string[]) {
        const files: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
            const normalized = normalizeCommandLineArg(args[i] ?? '');
            if (!normalized) {
                continue;
            }

            if (isSupportedFile(normalized)) {
                files.push(normalized);
                continue;
            }

            const joinedPath = findJoinedSupportedPath(args, i, normalized);
            if (joinedPath) {
                files.push(joinedPath.path);
                i = joinedPath.endIndex;
            }
        }
        return files;
    }

    function normalizeOpenRequestPaths(paths: string[]) {
        return uniq(paths
            .map(path => path.trim())
            .filter(path => path.length > 0));
    }

    function enqueueExternalOpenPath(normalizedPath: string) {
        let wasCoalesced = false;
        let droppedCount = 0;

        if (pendingExternalOpenPathSet.has(normalizedPath)) {
            wasCoalesced = true;
            const existingIndex = pendingExternalOpenPaths.indexOf(normalizedPath);
            if (existingIndex >= 0) {
                pendingExternalOpenPaths.splice(existingIndex, 1);
            } else {
                pendingExternalOpenPathSet.delete(normalizedPath);
            }
        }

        pendingExternalOpenPaths.push(normalizedPath);
        pendingExternalOpenPathSet.add(normalizedPath);

        while (pendingExternalOpenPaths.length > EXTERNAL_OPEN_PENDING_MAX_PATHS) {
            const droppedPath = pendingExternalOpenPaths.shift();
            if (!droppedPath) {
                break;
            }
            pendingExternalOpenPathSet.delete(droppedPath);
            droppedCount += 1;
        }

        return {
            coalescedCount: wasCoalesced ? 1 : 0,
            droppedCount,
        };
    }

    function queueOpenRequest(paths: string[]) {
        const normalizedPaths = normalizeOpenRequestPaths(paths);
        if (normalizedPaths.length === 0) {
            return;
        }

        let coalescedCount = 0;
        let droppedCount = 0;
        for (const normalizedPath of normalizedPaths) {
            const result = enqueueExternalOpenPath(normalizedPath);
            coalescedCount += result.coalescedCount;
            droppedCount += result.droppedCount;
        }

        if (coalescedCount > 0) {
            options.logger.debug(`Coalesced ${coalescedCount} duplicate external open path(s)`);
        }
        if (droppedCount > 0) {
            options.logger.warn(
                `External open queue exceeded cap (${EXTERNAL_OPEN_PENDING_MAX_PATHS}); dropped ${droppedCount} oldest path(s)`,
            );
        }

        finishStartupEmptyClaimGrace();
        if (externalOpenBootstrapReady && options.hasWindows()) {
            scheduleFlushPendingFiles();
        }
    }

    function getPendingPathsSnapshot() {
        return pendingExternalOpenPaths.slice();
    }

    function removePendingPaths(paths: string[]) {
        for (const path of paths) {
            const existingIndex = pendingExternalOpenPaths.indexOf(path);
            if (existingIndex >= 0) {
                pendingExternalOpenPaths.splice(existingIndex, 1);
            }
            pendingExternalOpenPathSet.delete(path);
        }
    }

    function finishStartupEmptyClaimGrace() {
        if (startupEmptyClaimGraceTimer) {
            clearTimeout(startupEmptyClaimGraceTimer);
            startupEmptyClaimGraceTimer = null;
        }

        const resolve = startupEmptyClaimGraceResolve;
        startupEmptyClaimGraceResolve = null;
        startupEmptyClaimGracePromise = null;
        resolve?.();
    }

    function waitForStartupExternalOpenGraceIfEmpty() {
        if (
            pendingExternalOpenPaths.length > 0
            || hasHandledInitialExternalOpenDispatch
        ) {
            return Promise.resolve();
        }

        if (startupEmptyClaimGracePromise) {
            return startupEmptyClaimGracePromise;
        }

        startupEmptyClaimGracePromise = new Promise<void>((resolve) => {
            startupEmptyClaimGraceResolve = resolve;
            startupEmptyClaimGraceTimer = setTimeout(
                finishStartupEmptyClaimGrace,
                EXTERNAL_OPEN_STARTUP_EMPTY_CLAIM_GRACE_MS,
            );
            startupEmptyClaimGraceTimer.unref?.();
        });
        return startupEmptyClaimGracePromise;
    }

    async function claimPendingOpenPaths() {
        await waitForStartupExternalOpenGraceIfEmpty();
        const paths = getPendingPathsSnapshot();
        if (paths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            return [];
        }

        removePendingPaths(paths);
        hasHandledInitialExternalOpenDispatch = true;
        pendingFlushRequested = pendingExternalOpenPaths.length > 0;
        if (pendingExternalOpenPaths.length === 0) {
            clearTimers();
        }
        options.logStartupPhase(`Claimed external file open batch (${paths.length} path(s))`);
        return paths;
    }

    function queueOpenRequestFromArgs(args: string[]) {
        const parsedPaths = collectSupportedPathsFromArgs(args);
        if (parsedPaths.length > 0) {
            options.logger.info(`Parsed external open paths (${parsedPaths.length}): ${parsedPaths.join(' | ')}`);
        }
        queueOpenRequest(parsedPaths);
    }

    function focusMainWindow() {
        const window = options.getMainWindow();
        if (!window) {
            return;
        }

        if (window.isMinimized()) {
            window.restore();
        }

        if (options.noFocus) {
            return;
        }

        window.focus();
    }

    function clearRetryPendingFilesTimer() {
        if (!retryPendingFilesTimer) {
            return;
        }

        clearTimeout(retryPendingFilesTimer);
        retryPendingFilesTimer = null;
    }

    function scheduleRetryPendingFiles() {
        if (
            retryPendingFilesTimer
            || !externalOpenBootstrapReady
            || pendingExternalOpenPaths.length === 0
        ) {
            return;
        }

        retryPendingFilesTimer = setTimeout(() => {
            retryPendingFilesTimer = null;
            flushPendingFiles();
        }, EXTERNAL_OPEN_RETRY_DISPATCH_MS);
        retryPendingFilesTimer.unref?.();
    }

    async function ensureMainWindowForExternalOpen() {
        if (!externalOpenBootstrapReady) {
            return;
        }

        if (!options.hasWindows()) {
            options.logger.info('External open requested without active windows; creating main window');
            await options.createWindow();
            options.logStartupPhase('Main window creation requested by external open');
        }

        focusMainWindow();
        scheduleFlushPendingFiles();
    }

    function requestMainWindowForExternalOpen() {
        if (ensureWindowForExternalOpenPromise) {
            return;
        }

        ensureWindowForExternalOpenPromise = (async () => {
            try {
                await ensureMainWindowForExternalOpen();
            } catch (error) {
                options.logger.error(`Failed to prepare window for external open: ${getErrorMessage(error)}`);
            } finally {
                ensureWindowForExternalOpenPromise = null;
            }
        })();
    }

    function flushPendingFiles() {
        if (flushPendingFilesTimer) {
            clearTimeout(flushPendingFilesTimer);
            flushPendingFilesTimer = null;
        }
        batchWindowStartTime = null;

        if (pendingExternalOpenPaths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            return;
        }

        if (!options.isMainWindowRendererReady()) {
            pendingFlushRequested = true;
            scheduleRetryPendingFiles();
            return;
        }

        clearRetryPendingFilesTimer();
        const paths = getPendingPathsSnapshot();
        if (paths.length === 0) {
            pendingFlushRequested = false;
            return;
        }

        options.logger.info(`Flushing ${paths.length} batched external open path(s)`);
        options.grantOpenPaths?.(paths);
        const dispatched = options.dispatchOpenPaths(paths);
        if (!dispatched) {
            pendingFlushRequested = true;
            options.logger.warn('External open dispatch could not reach the renderer; keeping paths queued for retry');
            scheduleRetryPendingFiles();
            return;
        }

        removePendingPaths(paths);
        pendingFlushRequested = pendingExternalOpenPaths.length > 0;
        options.logStartupPhase(`Dispatched external file open batch (${paths.length} path(s))`);
    }

    function scheduleFlushPendingFiles() {
        if (pendingExternalOpenPaths.length === 0) {
            pendingFlushRequested = false;
            clearRetryPendingFilesTimer();
            return;
        }

        pendingFlushRequested = true;

        if (!options.isMainWindowRendererReady()) {
            scheduleRetryPendingFiles();
            return;
        }

        if (!hasHandledInitialExternalOpenDispatch) {
            hasHandledInitialExternalOpenDispatch = true;
            flushPendingFiles();
            return;
        }

        const now = Date.now();
        if (batchWindowStartTime === null) {
            batchWindowStartTime = now;
        }

        if (now - batchWindowStartTime >= EXTERNAL_OPEN_MAX_BATCH_WAIT_MS) {
            flushPendingFiles();
            return;
        }

        if (flushPendingFilesTimer) {
            clearTimeout(flushPendingFilesTimer);
        }

        flushPendingFilesTimer = setTimeout(() => {
            flushPendingFiles();
        }, EXTERNAL_OPEN_BATCH_WINDOW_MS);
    }

    function clearTimers() {
        if (flushPendingFilesTimer) {
            clearTimeout(flushPendingFilesTimer);
            flushPendingFilesTimer = null;
        }
        clearRetryPendingFilesTimer();
        finishStartupEmptyClaimGrace();
        batchWindowStartTime = null;
    }

    return {
        clearTimers,
        isSupportedFile,
        markBootstrapReady() {
            externalOpenBootstrapReady = true;
            if (pendingFlushRequested || pendingExternalOpenPaths.length > 0) {
                scheduleRetryPendingFiles();
            }
        },
        queueOpenRequest,
        queueOpenRequestFromArgs,
        claimPendingOpenPaths,
        requestMainWindowForExternalOpen,
        scheduleFlushPendingFiles,
    };
}
