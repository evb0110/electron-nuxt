import { rmSync } from 'node:fs';
import puppeteer, {
    type Browser,
    type Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { sendCommand } from '../../../../scripts/electron-run/client';
import {
    NUXT_PORT,
    getSessionInfo,
    sessionDir,
    setCurrentSessionName,
    type TElectronRunCommand,
} from '../../../../scripts/electron-run/shared';
import {
    startSessionDetached,
    stopSingleSession,
    waitForSessionReady,
} from '../../../../scripts/electron-run/session-manager';

const SESSION_READY_TIMEOUT_MS = 120_000;
const RENDERER_READY_TIMEOUT_MS = 30_000;

export interface IElectronE2ESession {
    name: string;
    browser: Browser;
    page: Page;
    command: <T = unknown>(command: TElectronRunCommand, args?: unknown[], timeoutMs?: number) => Promise<T>;
    stop: () => Promise<void>;
}

async function waitForRendererReady(page: Page, timeoutMs = RENDERER_READY_TIMEOUT_MS) {
    await page.waitForFunction(() => {
        const nuxtRoot = document.querySelector('#__nuxt');
        const hasNuxt = Boolean(nuxtRoot && nuxtRoot.children.length > 0);
        const hasOpenFile = typeof (window as Window & { __openFileDirect?: unknown }).__openFileDirect === 'function';
        const hasElectronApi = typeof (window as Window & { electronAPI?: unknown }).electronAPI === 'object';
        return hasNuxt && hasOpenFile && hasElectronApi;
    }, { timeout: timeoutMs });
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

async function connectToSessionPage(sessionName: string) {
    setCurrentSessionName(sessionName);
    const info = getSessionInfo(sessionName);
    if (!info) {
        throw new Error(`Session '${sessionName}' metadata not found`);
    }

    const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${info.cdpPort}`,
        defaultViewport: null,
    });

    const targetUrlPrefix = `http://localhost:${NUXT_PORT}`;
    const pages = await browser.pages();
    let page = pages.find(candidate => candidate.url().startsWith(targetUrlPrefix)) ?? null;

    if (!page) {
        page = await browser.newPage();
        await page.goto(`${targetUrlPrefix}/`, {waitUntil: 'domcontentloaded'});
    }

    await waitForRendererReady(page);

    return {
        browser,
        page,
    };
}

export async function startElectronE2ESession(sessionName: string, options?: {clean?: boolean;}): Promise<IElectronE2ESession> {
    const clean = options?.clean ?? true;

    await stopSingleSession(sessionName);
    if (clean) {
        rmSync(sessionDir(sessionName), {
            recursive: true,
            force: true,
        });
    }

    setCurrentSessionName(sessionName);
    await startSessionDetached();

    const ready = await waitForSessionReady(SESSION_READY_TIMEOUT_MS);
    if (!ready) {
        throw new Error(`Session '${sessionName}' was not ready within ${Math.round(SESSION_READY_TIMEOUT_MS / 1000)}s`);
    }

    await waitForHealthReady(sessionName);
    const {
        browser,
        page,
    } = await connectToSessionPage(sessionName);

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
        await stopSingleSession(sessionName);
    };

    return {
        name: sessionName,
        browser,
        page,
        command,
        stop,
    };
}
