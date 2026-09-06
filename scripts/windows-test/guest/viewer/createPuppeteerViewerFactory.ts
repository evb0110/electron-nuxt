import type {
    Browser,
    Page,
} from 'puppeteer-core';
import { findFreePort } from '@scripts/electron-run/electronRunProcessTree';
import { waitForPackagedCdpEndpoint } from '@scripts/release/waitForPackagedCdpEndpoint';
import {
    connectInstrumentationBrowser,
    type IAppLaunchRecord,
    type IWindowsAppLauncher,
} from '@scripts/windows-test/guest/appLaunch';
import type { IGuestClock } from '@scripts/windows-test/guest/guestRuntime';
import {
    dismissFirstLaunchPrompt,
    waitForOwnedWindow,
} from '@scripts/windows-test/guest/native-ui/firstLaunchPrompt';
import type { INativeUiAdapter } from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import { createPuppeteerViewerDriver } from '@scripts/windows-test/guest/viewer/createPuppeteerViewerDriver';
import {
    viewerDefaultTimeouts,
    type IAcceptanceAppSession,
    type IViewerDriver,
    type IViewerFactory,
    type IViewerSession,
} from '@scripts/windows-test/guest/viewer/viewerDriver';

const VIEWER_PAGE_URL_PREFIX = 'evb-viewer://app/';

export interface ICreatePuppeteerViewerFactoryOptions {
    launcher: IWindowsAppLauncher;
    profileDirectory: string;
    nativeUi?: INativeUiAdapter;
    clock?: Pick<IGuestClock, 'now' | 'sleep'>;
    firstLaunchPromptTimeoutMs?: number;
    allocatePort?: () => Promise<number>;
    waitForBrowserReady?: (port: number, timeoutMs: number) => Promise<void>;
    connectBrowser?: (browserUrl: string) => Promise<Browser>;
    createDriver?: (page: Page) => IViewerDriver;
}

export function selectViewerPage(pages: readonly Page[]) {
    const viewerPage = pages.find(candidate => candidate.url().startsWith(VIEWER_PAGE_URL_PREFIX))
        ?? pages.find(candidate => !candidate.isClosed());
    if (viewerPage === undefined) {
        throw new Error('the instrumented application exposed no renderer page');
    }
    return viewerPage;
}

export function createPuppeteerViewerFactory({
    launcher,
    profileDirectory,
    nativeUi,
    clock,
    firstLaunchPromptTimeoutMs,
    allocatePort = findFreePort,
    waitForBrowserReady = async (port, timeoutMs) => {
        await waitForPackagedCdpEndpoint(port, timeoutMs, 'EVB Viewer');
    },
    connectBrowser = browserUrl => connectInstrumentationBrowser(browserUrl),
    createDriver = createPuppeteerViewerDriver,
}: ICreatePuppeteerViewerFactoryOptions): IViewerFactory {
    const dismissedFirstLaunchProfiles = new Set<string>();
    const handleFirstLaunchPrompt = async (record: IAppLaunchRecord) => {
        if (nativeUi === undefined) {
            return;
        }
        if (dismissedFirstLaunchProfiles.has(profileDirectory)) {
            return;
        }
        if (record.profile === 'acceptance') {
            await waitForOwnedWindow({
                adapter: nativeUi,
                processId: record.process.pid,
                query: {
                    titleContains: 'EVB Viewer',
                    className: 'Chrome_WidgetWin_1',
                },
                ...(clock === undefined ? {} : { clock }),
                timeoutMs: viewerDefaultTimeouts.startupMs,
            });
        }
        await dismissFirstLaunchPrompt({
            adapter: nativeUi,
            processId: record.process.pid,
            ...(clock === undefined ? {} : { clock }),
            ...(firstLaunchPromptTimeoutMs === undefined ? {} : { timeoutMs: firstLaunchPromptTimeoutMs }),
        });
        dismissedFirstLaunchProfiles.add(profileDirectory);
    };
    const closeInstrumented = async (browser: Browser, record: IAppLaunchRecord) => {
        await browser.disconnect();
        const outcome = launcher.terminate(record);
        if (!outcome.terminated) {
            throw new Error(`refusing to report a clean shutdown: ${outcome.reason}`);
        }
    };

    return {
        openInstrumented: async (documentPath): Promise<IViewerSession> => {
            const remoteDebuggingPort = await allocatePort();
            const record = launcher.launch({
                profile: 'instrumentation',
                remoteDebuggingPort,
                userDataDirectory: profileDirectory,
            });
            let browser: Browser | null = null;
            try {
                if (record.browserUrl === null) {
                    throw new Error('the instrumentation launch produced no loopback debugging URL');
                }
                await waitForBrowserReady(remoteDebuggingPort, viewerDefaultTimeouts.startupMs);
                const connected = await connectBrowser(record.browserUrl);
                browser = connected;
                await handleFirstLaunchPrompt(record);
                const driver = createDriver(selectViewerPage(await connected.pages()));
                await driver.openDocument(documentPath);
                await driver.waitUntilReady();
                return {
                    driver,
                    process: record.process,
                    close: () => closeInstrumented(connected, record),
                };
            } catch (error) {
                // The startup error is the one worth reporting; cleanup failures
                // must not replace it, and the process must not outlive the attempt.
                if (browser !== null) {
                    await Promise.resolve(browser.disconnect()).catch(() => undefined);
                }
                launcher.terminate(record);
                throw error;
            }
        },
        launchAcceptance: async (documentPath): Promise<IAcceptanceAppSession> => {
            const record = launcher.launch({
                profile: 'acceptance',
                ...(documentPath === undefined ? {} : { documentPath }),
            });
            try {
                await handleFirstLaunchPrompt(record);
                return {
                    process: record.process,
                    close: () => {
                        const outcome = launcher.terminate(record);
                        return outcome.terminated
                            ? Promise.resolve()
                            : Promise.reject(new Error(`refusing to report a clean shutdown: ${outcome.reason}`));
                    },
                };
            } catch (error) {
                launcher.terminate(record);
                throw error;
            }
        },
    };
}
