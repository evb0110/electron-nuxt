import { extname } from 'path';
import { fileURLToPath } from 'url';
import { uniq } from 'es-toolkit/array';

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
    dispatchOpenPaths: (paths: string[]) => void;
}

export function createExternalOpenManager(options: ICreateExternalOpenManagerOptions) {
    const pendingExternalOpenPaths: string[] = [];
    const pendingExternalOpenPathSet = new Set<string>();
    let flushPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
    let batchWindowStartTime: number | null = null;
    let externalOpenBootstrapReady = false;
    let ensureWindowForExternalOpenPromise: Promise<void> | null = null;
    let hasHandledInitialExternalOpenDispatch = false;

    function isSupportedFile(filePath: string) {
        return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
    }

    function normalizeCommandLineArg(arg: string): string | null {
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

            let candidate = normalized;
            for (let j = i + 1; j < args.length && j <= i + 7; j += 1) {
                const nextToken = normalizeCommandLineArg(args[j] ?? '');
                if (!nextToken) {
                    break;
                }
                candidate = `${candidate} ${nextToken}`;
                if (isSupportedFile(candidate)) {
                    files.push(candidate);
                    i = j;
                    break;
                }
            }
        }
        return files;
    }

    function queueOpenRequest(paths: string[]) {
        const normalizedPaths = uniq(paths
            .map(path => path.trim())
            .filter(path => path.length > 0));
        if (normalizedPaths.length === 0) {
            return;
        }

        let coalescedCount = 0;
        let droppedCount = 0;
        for (const normalizedPath of normalizedPaths) {
            if (pendingExternalOpenPathSet.has(normalizedPath)) {
                coalescedCount += 1;
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
        }

        if (coalescedCount > 0) {
            options.logger.debug(`Coalesced ${coalescedCount} duplicate external open path(s)`);
        }
        if (droppedCount > 0) {
            options.logger.warn(
                `External open queue exceeded cap (${EXTERNAL_OPEN_PENDING_MAX_PATHS}); dropped ${droppedCount} oldest path(s)`,
            );
        }
    }

    function collectMergedPendingPaths() {
        if (pendingExternalOpenPaths.length === 0) {
            return [];
        }
        const mergedPaths = pendingExternalOpenPaths.slice();
        pendingExternalOpenPaths.length = 0;
        pendingExternalOpenPathSet.clear();
        return mergedPaths;
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
                options.logger.error(`Failed to prepare window for external open: ${error instanceof Error ? error.message : String(error)}`);
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

        if (!options.isMainWindowRendererReady()) {
            return;
        }

        const paths = collectMergedPendingPaths();
        if (paths.length > 0) {
            options.logger.info(`Flushing ${paths.length} batched external open path(s)`);
            options.dispatchOpenPaths(paths);
            options.logStartupPhase(`Dispatched external file open batch (${paths.length} path(s))`);
        }
    }

    function scheduleFlushPendingFiles() {
        if (!options.isMainWindowRendererReady()) {
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
        batchWindowStartTime = null;
    }

    return {
        clearTimers,
        isSupportedFile,
        markBootstrapReady() {
            externalOpenBootstrapReady = true;
        },
        queueOpenRequest,
        queueOpenRequestFromArgs,
        requestMainWindowForExternalOpen,
        scheduleFlushPendingFiles,
    };
}
