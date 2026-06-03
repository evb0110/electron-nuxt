import { rmSync } from 'node:fs';
import puppeteer, {
    type Browser,
    type Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { sendCommand } from '@scripts/electron-run/client';
import { buildHeadlessAutomationEnv } from '@scripts/electron-run/electronRunLaunchConfig';
import { DEFAULT_NUXT_PORT } from '@scripts/electron-run/electronRunPortConfig';
import { isProcessAlive } from '@scripts/electron-run/electronRunProcessTree';
import {
    getSessionInfo,
    getSessionStartingInfo,
    readSessionLogTail,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    sessionDir,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import type { TElectronRunCommand } from '@scripts/electron-run/electronRunProtocol';
import {
    startSessionDetached,
    stopSingleSession,
    waitForSessionReady,
} from '@scripts/electron-run/sessionManager';
import { cleanupSessionFixtures } from '@tests/e2e/electron/helpers/fixtures';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';

const SESSION_READY_TIMEOUT_MS = 75_000;
const RENDERER_READY_TIMEOUT_MS = 30_000;
const SESSION_STOP_TIMEOUT_MS = 15_000;
const PRESERVE_E2E_ARTIFACTS_ENV = 'EVB_E2E_PRESERVE_ARTIFACTS';

export interface IElectronE2ESession {
    name: string;
    browser: Browser;
    page: Page;
    command: <T = unknown>(command: TElectronRunCommand, args?: unknown[], timeoutMs?: number) => Promise<T>;
    stop: () => Promise<void>;
}

function shouldPreserveE2EArtifacts(env: NodeJS.ProcessEnv = process.env) {
    const value = env[PRESERVE_E2E_ARTIFACTS_ENV]?.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function cleanupSessionArtifacts(sessionName: string) {
    cleanupSessionFixtures(sessionName);
    rmSync(sessionDir(sessionName), {
        recursive: true,
        force: true,
    });
}

function createSessionDiagnostics(sessionName: string) {
    setCurrentSessionName(sessionName);
    const info = getSessionInfo(sessionName);
    const starting = getSessionStartingInfo(sessionName);
    const details = {
        sessionName,
        info: info
            ? {
                ...info,
                pidAlive: isProcessAlive(info.pid),
                electronPidAlive: info.electronPid ? isProcessAlive(info.electronPid) : null,
                nuxtPidAlive: info.nuxtPid ? isProcessAlive(info.nuxtPid) : null,
            }
            : null,
        starting: starting
            ? {
                ...starting,
                pidAlive: isProcessAlive(starting.pid),
                ageMs: Date.now() - starting.startedAt,
            }
            : null,
    };
    const logTail = readSessionLogTail(120);
    return [
        `Session diagnostics: ${JSON.stringify(details, null, 2)}`,
        logTail ? `--- Recent session log ---\n${logTail}` : 'No session log tail available.',
    ].join('\n');
}

async function withSessionTimeout<T>(
    sessionName: string,
    label: string,
    timeoutMs: number,
    task: Promise<T>,
    options: { cleanupOnTimeout?: boolean } = {},
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            if (options.cleanupOnTimeout) {
                void stopSingleSession(sessionName).catch(() => {});
            }
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.\n${createSessionDiagnostics(sessionName)}`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            task,
            timeoutPromise,
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function waitForRendererReady(page: Page, timeoutMs = RENDERER_READY_TIMEOUT_MS) {
    await waitForFunctionInPage(page, () => {
        const nuxtRoot = document.querySelector('#__nuxt');
        const hasNuxt = Boolean(nuxtRoot && nuxtRoot.children.length > 0);
        const hasOpenFile = typeof (window as Window & { __openFileDirect?: unknown }).__openFileDirect === 'function';
        const hasElectronApi = typeof (window as Window & { electronAPI?: unknown }).electronAPI === 'object';
        return hasNuxt && hasOpenFile && hasElectronApi;
    }, { timeout: timeoutMs });
}

async function installPageEvaluationShims(page: Page) {
    const install = () => {
        (window as Window & { __name?: <TFunction extends (...args: never[]) => unknown>(fn: TFunction) => TFunction }).__name = fn => fn;
    };
    await page.evaluateOnNewDocument(install);
    await page.evaluate(install);
}

async function waitForHealthReady(sessionName: string, timeoutMs = SESSION_READY_TIMEOUT_MS) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            setCurrentSessionName(sessionName);
            const health = await sendCommand('health') as {ready?: boolean;};
            if (health?.ready) {
                return;
            }
        } catch {
            // Session startup races are expected; retry until timeout.
        }

        await delay(250);
    }

    throw new Error(`Session '${sessionName}' did not report ready health within ${Math.round(timeoutMs / 1000)}s`);
}

async function waitForPageTarget(cdpPort: number, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
            if (res.ok) {
                const targets = await res.json() as Array<{
                    type: string;
                    webSocketDebuggerUrl?: string;
                }>;
                if (targets.some(t => t.type === 'page' && t.webSocketDebuggerUrl)) {
                    return;
                }
            }
        } catch {
            // CDP endpoint not ready yet.
        }
        await delay(500);
    }
    throw new Error(`No page target found via /json/list within ${Math.round(timeoutMs / 1000)}s`);
}

async function getBrowserWsEndpoint(cdpPort: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!res.ok) {
        throw new Error(`Failed to fetch /json/version: HTTP ${res.status}`);
    }
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) {
        throw new Error('/json/version missing webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
}

async function connectToSessionPage(sessionName: string) {
    setCurrentSessionName(sessionName);
    const info = getSessionInfo(sessionName);
    if (!info) {
        throw new Error(`Session '${sessionName}' metadata not found`);
    }

    await waitForPageTarget(info.cdpPort);
    const browserWsUrl = await getBrowserWsEndpoint(info.cdpPort);
    const browser = await puppeteer.connect({
        browserWSEndpoint: browserWsUrl,
        defaultViewport: null,
        protocolTimeout: 420_000,
    });

    const nuxtPort = info.nuxtPort || DEFAULT_NUXT_PORT;
    const pages = await browser.pages();
    let page = pages.find(candidate => {
        const url = candidate.url();
        return url.startsWith('evb-viewer://app/')
            || url.includes(`localhost:${nuxtPort}`)
            || url.includes(`127.0.0.1:${nuxtPort}`);
    }) ?? null;

    if (!page) {
        page = pages.find(candidate => !candidate.isClosed()) ?? null;
        if (!page) {
            throw new Error('No Electron page found via CDP');
        }
        await page.goto(`http://127.0.0.1:${nuxtPort}/`, {waitUntil: 'domcontentloaded'});
    }

    await installPageEvaluationShims(page);
    await waitForRendererReady(page);

    return {
        browser,
        page,
    };
}

export async function startElectronE2ESession(sessionName: string, options?: {clean?: boolean;}): Promise<IElectronE2ESession> {
    const clean = options?.clean ?? true;

    await withSessionTimeout(
        sessionName,
        `Stopping stale Electron E2E session '${sessionName}'`,
        SESSION_STOP_TIMEOUT_MS,
        stopSingleSession(sessionName),
    );
    if (clean) {
        cleanupSessionArtifacts(sessionName);
    }

    setCurrentSessionName(sessionName);
    await withSessionTimeout(
        sessionName,
        `Starting Electron E2E session '${sessionName}'`,
        SESSION_READY_TIMEOUT_MS,
        startSessionDetached({ env: buildHeadlessAutomationEnv(process.env) }),
        { cleanupOnTimeout: true },
    );

    const ready = await withSessionTimeout(
        sessionName,
        `Waiting for Electron E2E session '${sessionName}' metadata`,
        SESSION_READY_TIMEOUT_MS,
        waitForSessionReady(SESSION_READY_TIMEOUT_MS),
        { cleanupOnTimeout: true },
    );
    if (!ready) {
        throw new Error(`Session '${sessionName}' was not ready within ${Math.round(SESSION_READY_TIMEOUT_MS / 1000)}s.\n${createSessionDiagnostics(sessionName)}`);
    }

    await withSessionTimeout(
        sessionName,
        `Waiting for Electron E2E session '${sessionName}' health`,
        SESSION_READY_TIMEOUT_MS,
        waitForHealthReady(sessionName, SESSION_READY_TIMEOUT_MS),
        { cleanupOnTimeout: true },
    );
    const {
        browser,
        page,
    } = await withSessionTimeout(
        sessionName,
        `Connecting to Electron E2E session '${sessionName}' renderer`,
        RENDERER_READY_TIMEOUT_MS + 20_000,
        connectToSessionPage(sessionName),
        { cleanupOnTimeout: true },
    );

    const command = async <T = unknown>(
        nextCommand: TElectronRunCommand,
        args: unknown[] = [],
        timeoutMs?: number,
    ) => {
        setCurrentSessionName(sessionName);
        return await sendCommand(nextCommand, args, timeoutMs) as T;
    };

    const stop = async () => {
        try {
            browser.disconnect();
        } catch {
            // Disconnect best-effort for cleanup.
        }
        await withSessionTimeout(
            sessionName,
            `Stopping Electron E2E session '${sessionName}'`,
            SESSION_STOP_TIMEOUT_MS,
            stopSingleSession(sessionName),
        );
        if (!shouldPreserveE2EArtifacts()) {
            cleanupSessionArtifacts(sessionName);
        }
    };

    return {
        name: sessionName,
        browser,
        page,
        command,
        stop,
    };
}
