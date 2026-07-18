import { EventEmitter } from 'events';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runInitSequence } from '@electron/bootstrap/runInitSequence';
import { canonicalBundledApplicationVersion } from '@electron/appVersion';
import { config } from '@electron/config';

vi.mock('@electron/config', () => ({config: {
    automation: { noFocus: false },
    isMac: false,
}}));

interface IRegisteredExternalOpenIpcHandlers {
    onRendererReady?: (event: { sender: EventEmitter; }) => void;
    claimPendingExternalOpenPaths?: (event: { sender: EventEmitter; }) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (event: { sender: EventEmitter; }, failedPaths: string[]) => void;
}

describe('runInitSequence external open IPC', () => {
    async function createHarness(options: {
        allowMultipleAutomationSessions?: boolean;
        appVersion?: string;
        gracefulQuitInProgress?: boolean;
        hasWindows?: boolean;
        isPackaged?: boolean;
    } = {}) {
        const app = new EventEmitter() as EventEmitter & {
            dock?: { hide: () => void; };
            hide: () => void;
            isPackaged: boolean;
            getVersion: () => string;
            quit: () => void;
            requestSingleInstanceLock: () => boolean;
            setAboutPanelOptions: (options: unknown) => void;
            whenReady: () => Promise<void>;
        };
        app.isPackaged = options.isPackaged ?? true;
        app.getVersion = vi.fn(() => options.appVersion ?? '1.0.0');
        app.hide = vi.fn();
        app.quit = vi.fn();
        app.requestSingleInstanceLock = vi.fn(() => true);
        app.setAboutPanelOptions = vi.fn();
        app.whenReady = vi.fn(async () => {});

        const mainWebContents = {};
        const otherWebContents = {};
        const mainWindow = Object.assign(new EventEmitter(), {
            id: 1,
            webContents: Object.assign(new EventEmitter(), mainWebContents),
        });
        const otherWindow = Object.assign(new EventEmitter(), {
            id: 2,
            webContents: Object.assign(new EventEmitter(), otherWebContents),
        });
        const capturedHandlers: IRegisteredExternalOpenIpcHandlers = {};
        const externalOpenManager = {
            queueOpenRequestFromArgs: vi.fn(),
            requestMainWindowForExternalOpen: vi.fn(),
            scheduleFlushPendingFiles: vi.fn(),
            claimPendingOpenPaths: vi.fn(async () => ['/docs/startup.pdf']),
            acknowledgeClaimedOpenPaths: vi.fn(),
            markBootstrapReady: vi.fn(),
        };
        const allowOpenPaths = vi.fn();
        const focusMainWindow = vi.fn();
        const createWindow = vi.fn(async () => mainWindow as never);
        const sweepStaleManagedScratchTempDirs = vi.fn(async () => {});
        const shutdownCoordinator = options.gracefulQuitInProgress === undefined
            ? null
            : {
                isFatalShutdownInProgress: vi.fn(() => false),
                isGracefulQuitInProgress: vi.fn(() => options.gracefulQuitInProgress ?? false),
                isQuittingAfterCleanup: vi.fn(() => false),
                requestGracefulQuit: vi.fn(),
            };

        await runInitSequence({
            app: app as never,
            aboutIconPath: '/app/icon.png',
            allowMultipleAutomationSessions: options.allowMultipleAutomationSessions ?? false,
            allowOpenPaths,
            attachHostEnvironmentToWindow: vi.fn(),
            broadcastUpdateStatus: vi.fn(),
            cleanupStaleWorkingCopyDirectories: vi.fn(async () => ({
                removedDirectories: 0,
                removedOcrDirectories: 0,
            })),
            createWindow,
            devDockBadgeText: '',
            devDockIconPath: '',
            externalOpenManager,
            focusMainWindow,
            getMainWindow: vi.fn(() => mainWindow as never),
            getWindowFromWebContents: vi.fn((webContents: object) => {
                if (webContents === mainWindow.webContents) {
                    return mainWindow as never;
                }
                if (webContents === otherWindow.webContents) {
                    return otherWindow as never;
                }
                return null;
            }),
            hasWindows: vi.fn(() => options.hasWindows ?? true),
            initRecentFilesCache: vi.fn(async () => {}),
            initializeUpdates: vi.fn(),
            installHostEnvironmentDisplayWatcher: vi.fn(),
            logger: {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
            },
            logStartupPhase: vi.fn(),
            markWindowRendererReady: vi.fn(),
            markWindowTabTransferNotReady: vi.fn(),
            markWindowTabTransferReady: vi.fn(),
            markWindowTabTransferWindowClosed: vi.fn(),
            maybePromptForDefaultViewer: vi.fn(),
            readyWindowIds: new Set<number>(),
            registerIpcHandlers: vi.fn((handlers: IRegisteredExternalOpenIpcHandlers) => {
                Object.assign(capturedHandlers, handlers);
            }),
            setupAppProtocolHandler: vi.fn(),
            setupMenu: vi.fn(),
            shouldResetRendererReadyOnNavigation: vi.fn(() => true),
            shutdownCoordinator,
            sweepStaleDefaultAppTempPdfs: vi.fn(async () => {}),
            sweepStaleManagedScratchTempDirs,
        });

        return {
            app,
            allowOpenPaths,
            capturedHandlers,
            createWindow,
            externalOpenManager,
            focusMainWindow,
            mainWindow,
            otherWindow,
            shutdownCoordinator,
            sweepStaleManagedScratchTempDirs,
        };
    }

    async function claimStartupPath(harness: Awaited<ReturnType<typeof createHarness>>) {
        await expect(harness.capturedHandlers.claimPendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
        )).resolves.toEqual(['/docs/startup.pdf']);
    }

    it('uses the canonical application version in the macOS About panel', async () => {
        const harness = await createHarness({appVersion: '0.1.387'});

        expect(harness.app.setAboutPanelOptions).toHaveBeenCalledWith({
            applicationName: 'EVB Viewer',
            applicationVersion: '0.1.387',
            version: 'Beta',
            copyright: 'Copyright © 2026 Eugene Barsky',
            iconPath: '/app/icon.png',
            authors: ['Eugene Barsky'],
        });
    });

    it('never displays the generic Electron runtime version in the development About panel', async () => {
        const harness = await createHarness({
            appVersion: '42.3.3',
            isPackaged: false,
        });

        expect(harness.app.setAboutPanelOptions).toHaveBeenCalledWith(expect.objectContaining({
            applicationVersion: canonicalBundledApplicationVersion,
            version: 'Beta',
        }));
    });

    it('shows and focuses the main window when its renderer becomes ready', async () => {
        const harness = await createHarness();

        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents});

        expect(harness.focusMainWindow).toHaveBeenCalledTimes(1);
    });

    it('does not refocus the main window when the existing renderer signals ready after a reload', async () => {
        const harness = await createHarness();

        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents});
        harness.capturedHandlers.onRendererReady?.({sender: harness.mainWindow.webContents});

        expect(harness.focusMainWindow).toHaveBeenCalledTimes(1);
    });

    it('acknowledges failed startup opens only from the claiming WebContents and claimed paths', async () => {
        const harness = await createHarness();

        await expect(harness.capturedHandlers.claimPendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
        )).resolves.toEqual(['/docs/startup.pdf']);

        expect(harness.allowOpenPaths).toHaveBeenCalledWith(
            ['/docs/startup.pdf'],
            harness.mainWindow.webContents,
        );

        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            {sender: harness.otherWindow.webContents},
            ['/docs/startup.pdf'],
        );
        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
            ['/docs/other.pdf'],
        );

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).not.toHaveBeenCalled();

        harness.capturedHandlers.acknowledgePendingExternalOpenPaths?.(
            {sender: harness.mainWindow.webContents},
            ['/docs/startup.pdf'],
        );

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledTimes(1);
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('queues startup argv open paths on macOS when the automation harness is active', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'darwin',
        });
        try {
            const automationHarness = await createHarness({allowMultipleAutomationSessions: true});
            expect(automationHarness.externalOpenManager.queueOpenRequestFromArgs)
                .toHaveBeenCalledWith(process.argv.slice(1));

            const finderHarness = await createHarness();
            expect(finderHarness.externalOpenManager.queueOpenRequestFromArgs).not.toHaveBeenCalled();
        } finally {
            if (platformDescriptor) {
                Object.defineProperty(process, 'platform', platformDescriptor);
            }
        }
    });

    it('starts managed scratch temp cleanup during boot cleanup', async () => {
        const harness = await createHarness();

        expect(harness.sweepStaleManagedScratchTempDirs).toHaveBeenCalledTimes(1);
    });

    it('quits when the last window closes outside macOS', async () => {
        const harness = await createHarness();

        harness.app.emit('window-all-closed');

        expect(harness.app.quit).toHaveBeenCalledOnce();
    });

    it('does not recreate a window while graceful quit cleanup is running', async () => {
        const harness = await createHarness({
            gracefulQuitInProgress: true,
            hasWindows: false,
        });
        expect(harness.createWindow).toHaveBeenCalledOnce();

        harness.app.emit('activate');

        expect(harness.createWindow).toHaveBeenCalledOnce();
    });

    it('routes non-macOS last-window close through coordinated cleanup when available', async () => {
        const harness = await createHarness({gracefulQuitInProgress: false});

        harness.app.emit('window-all-closed');

        expect(harness.shutdownCoordinator?.requestGracefulQuit).toHaveBeenCalledOnce();
        expect(harness.app.quit).not.toHaveBeenCalled();
    });

    it('keeps the macOS application alive after its last window closes', async () => {
        const originalIsMac = config.isMac;
        (config as { isMac: boolean }).isMac = true;
        try {
            const harness = await createHarness({gracefulQuitInProgress: false});

            harness.app.emit('window-all-closed');

            expect(harness.shutdownCoordinator?.requestGracefulQuit).not.toHaveBeenCalled();
            expect(harness.app.quit).not.toHaveBeenCalled();
        } finally {
            (config as { isMac: boolean }).isMac = originalIsMac;
        }
    });

    it('quits an isolated macOS automation app after its last window closes', async () => {
        const originalIsMac = config.isMac;
        (config as { isMac: boolean }).isMac = true;
        try {
            const harness = await createHarness({
                allowMultipleAutomationSessions: true,
                gracefulQuitInProgress: false,
            });

            harness.app.emit('window-all-closed');

            expect(harness.shutdownCoordinator?.requestGracefulQuit).toHaveBeenCalledOnce();
            expect(harness.app.quit).not.toHaveBeenCalled();
        } finally {
            (config as { isMac: boolean }).isMac = originalIsMac;
        }
    });

    it('requeues an unacknowledged startup claim when the main renderer navigates', async () => {
        const harness = await createHarness();
        harness.app.emit('browser-window-created', {}, harness.mainWindow);

        await claimStartupPath(harness);
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).not.toHaveBeenCalled();

        harness.mainWindow.webContents.emit('did-start-navigation', {}, 'app://renderer/reload', false, true);

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('requeues an unacknowledged startup claim when the renderer process is gone', async () => {
        const harness = await createHarness();
        harness.app.emit('browser-window-created', {}, harness.mainWindow);

        await claimStartupPath(harness);
        harness.mainWindow.webContents.emit('render-process-gone');

        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('uses creation-time window identities after Electron destroys closed-window getters', async () => {
        const harness = await createHarness();
        harness.app.emit('browser-window-created', {}, harness.mainWindow);
        await claimStartupPath(harness);

        Object.defineProperties(harness.mainWindow, {
            id: {get: () => { throw new TypeError('Object has been destroyed'); }},
            webContents: {get: () => { throw new TypeError('Object has been destroyed'); }},
        });

        expect(() => harness.mainWindow.emit('closed')).not.toThrow();
        expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
    });

    it('requeues an unacknowledged startup claim after the claim timeout', async () => {
        vi.useFakeTimers();
        try {
            const harness = await createHarness();

            await claimStartupPath(harness);
            await vi.advanceTimersByTimeAsync(30_000);

            expect(harness.externalOpenManager.acknowledgeClaimedOpenPaths).toHaveBeenCalledWith(['/docs/startup.pdf']);
        } finally {
            vi.useRealTimers();
        }
    });
});
