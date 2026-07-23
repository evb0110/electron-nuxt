import type { ILogger } from '@electron/utils/createLogger';
import type {
    App,
    BrowserWindow,
    IpcMainEvent,
    IpcMainInvokeEvent,
    WebContents,
} from 'electron';
import { config } from '@electron/config';
import { getErrorMessage } from '@electron/utils/error';
import type { IAppUpdateStatus } from '@contracts/electronApiUpdates';
import { PACKAGED_STARTUP_READY_MARKER } from '@contracts/packagedStartupReadyMarker';
import { resolveApplicationVersion } from '@electron/appVersion';

interface IShutdownCoordinator {
    isGracefulQuitInProgress(): boolean;
    isQuittingAfterCleanup(): boolean;
    isFatalShutdownInProgress(): boolean;
    requestGracefulQuit(options?: { afterCleanup?: () => void }): void;
}

interface IExternalOpenManager {
    queueOpenRequestFromArgs(args: string[]): void;
    requestMainWindowForExternalOpen(): void;
    scheduleFlushPendingFiles(): void;
    claimPendingOpenPaths(): Promise<string[]>;
    acknowledgeClaimedOpenPaths(failedPaths: string[]): void;
    markBootstrapReady(): void;
}

function normalizeAcknowledgedExternalOpenPaths(paths: string[]) {
    const normalizedPaths: string[] = [];
    const seenPaths = new Set<string>();
    for (const path of paths) {
        const normalizedPath = path.trim();
        if (!normalizedPath || seenPaths.has(normalizedPath)) {
            continue;
        }
        seenPaths.add(normalizedPath);
        normalizedPaths.push(normalizedPath);
    }
    return normalizedPaths;
}

interface IRegisterIpcHandlersOptions {
    onRendererReady?: (event: IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (event: IpcMainInvokeEvent) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (event: IpcMainInvokeEvent, failedPaths: string[]) => void;
}

function shouldWaitForInitialRendererReady() {
    return process.env.EVB_WAIT_RENDERER_READY === '1';
}

const STARTUP_EXTERNAL_OPEN_CLAIM_TIMEOUT_MS = 30_000;

interface IStartupExternalOpenClaim {
    paths: Set<string>;
    timeout: ReturnType<typeof setTimeout> | null;
}

interface IStartupExternalOpenClaimTracker {
    acknowledge(sender: WebContents, failedPaths: string[]): boolean;
    requeue(sender: WebContents, reason: string): void;
    track(sender: WebContents, paths: string[]): void;
}

export interface IRunInitSequenceOptions {
    app: App;
    aboutIconPath: string;
    allowMultipleAutomationSessions: boolean;
    allowOpenPaths(paths: string[], webContents: WebContents): void;
    attachHostEnvironmentToWindow(window: BrowserWindow): void;
    broadcastUpdateStatus(status: IAppUpdateStatus): void;
    cleanupStaleWorkingCopyDirectories(): Promise<{
        removedDirectories: number;
        removedOcrDirectories: number;
    }>;
    createWindow(options?: {
        showStartupPlaceholder?: boolean;
        waitForInitialRendererReady?: boolean;
    }): Promise<BrowserWindow>;
    devDockBadgeText: string;
    devDockIconPath: string;
    externalOpenManager: IExternalOpenManager;
    focusMainWindow(): void;
    getMainWindow(): BrowserWindow | null;
    getWindowFromWebContents(webContents: WebContents): BrowserWindow | null;
    hasWindows(): boolean;
    initRecentFilesCache(): Promise<void>;
    initializeResourceRuntime(): Promise<void>;
    initializeUpdates(onStatus: (status: IAppUpdateStatus) => void): void;
    installHostEnvironmentDisplayWatcher(): void;
    logger: ILogger;
    logStartupPhase(message: string): void;
    markWindowRendererReady(windowId: number): void;
    markWindowTabTransferNotReady(windowId: number): void;
    markWindowTabTransferReady(windowId: number): void;
    markWindowTabTransferWindowClosed(windowId: number): void;
    maybePromptForDefaultViewer(): void;
    readyWindowIds: Set<number>;
    registerIpcHandlers(options: IRegisterIpcHandlersOptions): void;
    setupAppProtocolHandler(): void;
    setupMenu(): void;
    shouldResetRendererReadyOnNavigation(options: {
        isMainFrame: boolean;
        isInPlace: boolean;
    }): boolean;
    shutdownCoordinator: IShutdownCoordinator | null;
    sweepStaleDefaultAppTempPdfs(): Promise<unknown>;
    sweepStaleManagedScratchTempDirs?: () => Promise<unknown>;
    sweepStaleOcrTempArtifacts?: () => Promise<unknown>;
    pruneStaleDjvuArtifactJobs?: () => Promise<unknown>;
}

function createStartupExternalOpenClaimTracker(options: Pick<IRunInitSequenceOptions, 'externalOpenManager' | 'logger'>): IStartupExternalOpenClaimTracker {
    const claimsBySender = new Map<WebContents, IStartupExternalOpenClaim>();

    function clearClaim(sender: WebContents) {
        const claim = claimsBySender.get(sender);
        if (!claim) {
            return null;
        }

        if (claim.timeout) {
            clearTimeout(claim.timeout);
            claim.timeout = null;
        }
        claimsBySender.delete(sender);
        return claim;
    }

    function requeue(sender: WebContents, reason: string) {
        const claim = clearClaim(sender);
        if (!claim) {
            return;
        }

        const paths = Array.from(claim.paths);
        options.externalOpenManager.acknowledgeClaimedOpenPaths(paths);
        options.logger.warn(`Requeued ${paths.length} unacknowledged startup external open path(s) after ${reason}`);
    }

    function track(sender: WebContents, paths: string[]) {
        requeue(sender, 'replacement startup claim');

        const claim: IStartupExternalOpenClaim = {
            paths: new Set(paths),
            timeout: null,
        };
        claim.timeout = setTimeout(() => {
            requeue(sender, 'claim timeout');
        }, STARTUP_EXTERNAL_OPEN_CLAIM_TIMEOUT_MS);
        claim.timeout.unref?.();
        claimsBySender.set(sender, claim);
    }

    function acknowledge(sender: WebContents, failedPaths: string[]) {
        const claim = claimsBySender.get(sender);
        if (!claim) {
            return false;
        }

        const normalizedFailedPaths = normalizeAcknowledgedExternalOpenPaths(failedPaths);
        if (
            normalizedFailedPaths.length > claim.paths.size
            || normalizedFailedPaths.some(path => !claim.paths.has(path))
        ) {
            return false;
        }

        clearClaim(sender);
        options.externalOpenManager.acknowledgeClaimedOpenPaths(normalizedFailedPaths);
        return true;
    }

    return {
        acknowledge,
        requeue,
        track,
    };
}

function bootSingleInstance(options: IRunInitSequenceOptions) {
    const {
        allowMultipleAutomationSessions,
        app,
        externalOpenManager,
        logger,
    } = options;

    if (!allowMultipleAutomationSessions) {
        const singleInstanceLock = app.requestSingleInstanceLock();
        if (!singleInstanceLock) {
            app.quit();
            process.exit(0);
        }
    } else {
        logger.info('Automation harness mode: bypassing single-instance lock to allow multiple sessions');
    }

    if (process.platform !== 'darwin' || allowMultipleAutomationSessions) {
        externalOpenManager.queueOpenRequestFromArgs(process.argv.slice(1));
    }

    app.on('second-instance', (_event, commandLine) => {
        externalOpenManager.queueOpenRequestFromArgs(commandLine.slice(1));
        externalOpenManager.requestMainWindowForExternalOpen();
    });
}

async function bootProtocol(options: IRunInitSequenceOptions) {
    options.logStartupPhase('Bootstrap init started');
    await options.app.whenReady();
    options.logStartupPhase('app.whenReady resolved');
    options.setupAppProtocolHandler();
}

async function bootDevDockIcon(options: IRunInitSequenceOptions) {
    const {
        app,
        devDockBadgeText,
        devDockIconPath,
        logger,
    } = options;

    if (config.automation.noFocus && process.platform === 'darwin') {
        try {
            app.dock?.hide();
        } catch (error) {
            logger.warn(`Failed to hide dock before window creation in automation mode: ${getErrorMessage(error)}`);
        }
        app.hide();
    }

    if (process.platform !== 'darwin' || app.isPackaged || config.automation.noFocus) {
        return;
    }

    try {
        const { createDevDockIcon } = await import('@electron/bootstrap/createDevDockIcon');
        const devDockIcon = createDevDockIcon(devDockIconPath);
        app.dock?.setIcon(devDockIcon ?? devDockIconPath);
        app.dock?.setBadge(devDockBadgeText);
    } catch (error) {
        logger.warn(`Failed to set dock icon: ${getErrorMessage(error)}`);
    }
}

function bootAboutPanel(options: IRunInitSequenceOptions) {
    const appVersion = resolveApplicationVersion(options.app);
    options.app.setAboutPanelOptions({
        applicationName: 'EVB Viewer',
        applicationVersion: appVersion,
        ...(appVersion.startsWith('0.') ? { version: 'Beta' } : {}),
        copyright: 'Copyright \u00A9 2026 Eugene Barsky',
        iconPath: options.aboutIconPath,
        authors: ['Eugene Barsky'],
    });
}

function bootIpc(
    options: IRunInitSequenceOptions,
    startupExternalOpenClaims: IStartupExternalOpenClaimTracker,
) {
    const {
        allowOpenPaths,
        externalOpenManager,
        focusMainWindow,
        getMainWindow,
        getWindowFromWebContents,
        logStartupPhase,
        markWindowRendererReady,
        markWindowTabTransferReady,
        maybePromptForDefaultViewer,
        readyWindowIds,
        registerIpcHandlers,
    } = options;
    const rendererReadyFocusHandled = new WeakSet<WebContents>();
    registerIpcHandlers({
        onRendererReady: (event) => {
            const window = getWindowFromWebContents(event.sender);
            if (!window) {
                return;
            }

            const shouldFocusForInitialReady = !rendererReadyFocusHandled.has(event.sender);
            rendererReadyFocusHandled.add(event.sender);
            readyWindowIds.add(window.id);
            markWindowTabTransferReady(window.id);

            externalOpenManager.scheduleFlushPendingFiles();
            markWindowRendererReady(window.id);
            if (window.id === getMainWindow()?.id) {
                if (shouldFocusForInitialReady) {
                    focusMainWindow();
                }
                logStartupPhase(`${PACKAGED_STARTUP_READY_MARKER} Main renderer signaled ready (windowId=${window.id})`);
                maybePromptForDefaultViewer();
            }
        },
        claimPendingExternalOpenPaths: async (event) => {
            const window = getWindowFromWebContents(event.sender);
            if (!window || window.id !== getMainWindow()?.id) {
                return [];
            }

            const paths = await externalOpenManager.claimPendingOpenPaths();
            if (paths.length === 0) {
                return [];
            }
            startupExternalOpenClaims.track(event.sender, paths);
            allowOpenPaths(paths, event.sender);
            return paths;
        },
        acknowledgePendingExternalOpenPaths: (event, failedPaths) => {
            const window = getWindowFromWebContents(event.sender);
            if (!window || window.id !== getMainWindow()?.id) {
                return;
            }

            startupExternalOpenClaims.acknowledge(event.sender, failedPaths);
        },
    });
    logStartupPhase('IPC handlers registered');
}

function bootCleanup(options: IRunInitSequenceOptions) {
    const {
        cleanupStaleWorkingCopyDirectories,
        logger,
        sweepStaleDefaultAppTempPdfs,
        sweepStaleManagedScratchTempDirs,
        sweepStaleOcrTempArtifacts,
        pruneStaleDjvuArtifactJobs,
    } = options;

    void sweepStaleDefaultAppTempPdfs().catch((error: unknown) => {
        logger.warn(`Failed to sweep stale default-app temp PDFs: ${String(error)}`);
    });

    void pruneStaleDjvuArtifactJobs?.().catch((error: unknown) => {
        logger.warn(`Failed to prune stale DjVu artifact jobs: ${getErrorMessage(error)}`);
    });

    void sweepStaleOcrTempArtifacts?.().catch((error: unknown) => {
        logger.warn(`Failed to sweep stale OCR temp artifacts: ${getErrorMessage(error)}`);
    });

    void sweepStaleManagedScratchTempDirs?.().catch((error: unknown) => {
        logger.warn(`Failed to sweep stale managed scratch temp directories: ${getErrorMessage(error)}`);
    });

    void cleanupStaleWorkingCopyDirectories()
        .then((result) => {
            if (result.removedDirectories > 0 || result.removedOcrDirectories > 0) {
                logger.info(
                    `Removed stale working-copy directories: work=${result.removedDirectories}, ocr=${result.removedOcrDirectories}`,
                );
            }
        })
        .catch((error) => {
            logger.warn(`Failed to cleanup stale working-copy directories: ${getErrorMessage(error)}`);
        });
}

function bootWindowLifecycle(
    options: IRunInitSequenceOptions,
    startupExternalOpenClaims: IStartupExternalOpenClaimTracker,
) {
    const {
        app,
        attachHostEnvironmentToWindow,
        createWindow,
        externalOpenManager,
        focusMainWindow,
        hasWindows,
        logger,
        markWindowTabTransferNotReady,
        markWindowTabTransferWindowClosed,
        readyWindowIds,
        shouldResetRendererReadyOnNavigation,
        shutdownCoordinator,
    } = options;

    app.on('browser-window-created', (_event, window) => {
        attachHostEnvironmentToWindow(window);
        const windowId = window.id;
        const windowWebContents = window.webContents;

        const markNotReady = (reason: string) => {
            readyWindowIds.delete(windowId);
            markWindowTabTransferNotReady(windowId);
            startupExternalOpenClaims.requeue(windowWebContents, reason);
        };

        window.webContents.on('did-start-navigation', (_navEvent, _url, isInPlace, isMainFrame) => {
            if (!shouldResetRendererReadyOnNavigation({
                isMainFrame,
                isInPlace,
            })) {
                return;
            }
            markNotReady('main-frame navigation');
        });
        window.webContents.on('render-process-gone', () => markNotReady('renderer process gone'));

        window.on('closed', () => {
            markNotReady('window closed');
            markWindowTabTransferWindowClosed(windowId);
        });
    });

    app.on('window-all-closed', () => {
        if (config.isMac && !options.allowMultipleAutomationSessions) {
            return;
        }
        logger.info('All application windows closed; requesting graceful quit');
        if (shutdownCoordinator) {
            shutdownCoordinator.requestGracefulQuit();
            return;
        }
        app.quit();
    });

    app.on('before-quit', (event) => {
        if (shutdownCoordinator?.isQuittingAfterCleanup() || shutdownCoordinator?.isFatalShutdownInProgress()) {
            return;
        }
        event.preventDefault();
        shutdownCoordinator?.requestGracefulQuit();
    });

    app.on('activate', () => {
        if (config.automation.noFocus) {
            return;
        }
        if (
            shutdownCoordinator?.isGracefulQuitInProgress()
            || shutdownCoordinator?.isFatalShutdownInProgress()
        ) {
            return;
        }

        if (!hasWindows()) {
            readyWindowIds.clear();
            void createWindow().catch((error) => {
                logger.error(`Failed to create window on activate: ${getErrorMessage(error)}`);
            });
            return;
        }
        focusMainWindow();
        externalOpenManager.scheduleFlushPendingFiles();
    });
}

async function bootMainWindow(options: IRunInitSequenceOptions) {
    const {
        app,
        createWindow,
        externalOpenManager,
        logger,
        logStartupPhase,
        readyWindowIds,
    } = options;

    externalOpenManager.markBootstrapReady();
    readyWindowIds.clear();
    logStartupPhase('Creating main window');
    await createWindow({
        showStartupPlaceholder: false,
        waitForInitialRendererReady: shouldWaitForInitialRendererReady(),
    });
    logStartupPhase('Main window creation requested');

    if (config.automation.noFocus && process.platform === 'darwin') {
        try {
            if (app.dock) {
                app.dock.hide();
            }
        } catch (error) {
            logger.warn(`Failed to hide dock in automation mode: ${getErrorMessage(error)}`);
        }
        app.hide();
    }
}

function bootUpdates(options: IRunInitSequenceOptions) {
    try {
        options.initializeUpdates(options.broadcastUpdateStatus);
        options.logStartupPhase('Update service initialized');
    } catch (error) {
        options.logger.error(`Failed to initialize updates: ${getErrorMessage(error)}`);
    }
}

async function bootRecentFiles(options: IRunInitSequenceOptions) {
    try {
        await options.initRecentFilesCache();
        options.logStartupPhase('Recent files cache initialized');
    } catch (error) {
        options.logger.error(`Failed to initialize recent files cache: ${getErrorMessage(error)}`);
    }
}

function bootMenu(options: IRunInitSequenceOptions) {
    try {
        options.setupMenu();
        options.logStartupPhase('Application menu initialized');
    } catch (error) {
        options.logger.error(`Failed to initialize application menu: ${getErrorMessage(error)}`);
    }
}

export async function runInitSequence(options: IRunInitSequenceOptions) {
    const startupExternalOpenClaims = createStartupExternalOpenClaimTracker(options);
    bootSingleInstance(options);
    await bootProtocol(options);
    await options.initializeResourceRuntime();
    await bootDevDockIcon(options);
    bootAboutPanel(options);
    bootIpc(options, startupExternalOpenClaims);
    options.installHostEnvironmentDisplayWatcher();
    bootCleanup(options);
    bootWindowLifecycle(options, startupExternalOpenClaims);
    await bootMainWindow(options);

    void (async () => {
        bootUpdates(options);
        await bootRecentFiles(options);
        bootMenu(options);
    })();
}
