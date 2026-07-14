import {spawn} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PDFDocument} from 'pdf-lib';
import puppeteer from 'puppeteer-core';
import type {Page} from 'puppeteer-core';
import {
    findFreePort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {capturePackagedCorePdfFailureArtifacts} from '@tests/e2e/electron/helpers/capturePackagedCorePdfFailureArtifacts';
import {
    getActiveWorkspaceWorkingCopyPath,
    rotatePages,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {createFreeTextAnnotation} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {installPageEvaluationShims} from '@tests/e2e/electron/helpers/pageRuntime';
import {getWorkspaceToolbarSnapshot} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readPdfAnnotationSummary} from '@tests/e2e/electron/helpers/fixtures';

const STARTUP_TIMEOUT_MS = 75_000;
const OPERATION_TIMEOUT_MS = 45_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
type TConnectedBrowser = Awaited<ReturnType<typeof puppeteer.connect>>;

function parseExecutablePath(args: string[]) {
    const index = args.indexOf('--executable');
    const executablePath = index >= 0 ? args[index + 1] : undefined;
    if (!executablePath) {
        throw new Error('Usage: verifyPackagedCorePdfSmoke.ts --executable <packaged-executable>');
    }
    return path.resolve(executablePath);
}

async function createFixturePdf(filePath: string) {
    const document = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        page.drawText(`Packaged smoke searchable text page ${pageNumber}`, {
            x: 72,
            y: 700,
            size: 18,
        });
    }
    await writeFile(filePath, await document.save());
}

async function waitForCdpEndpoint(port: number) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
                const payload = await response.json() as {webSocketDebuggerUrl?: string};
                if (payload.webSocketDebuggerUrl) {
                    return payload.webSocketDebuggerUrl;
                }
            }
        } catch {
            // Packaged Electron is still starting.
        }
        await delay(250);
    }
    throw new Error(`Packaged Electron did not expose CDP on port ${port}`);
}

async function waitForSaveEnabled(page: Page) {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const snapshot = await getWorkspaceToolbarSnapshot(page);
        if (snapshot?.canSave === true && snapshot.isAnySaving !== true) {
            return;
        }
        await delay(100);
    }
    throw new Error('Packaged smoke Save action did not become enabled');
}

async function waitForSavedAnnotation(filePath: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let summary = await readPdfAnnotationSummary(filePath);

    while (Date.now() < deadline) {
        if ((summary.bySubtype.FreeText ?? 0) > 0) {
            return summary;
        }
        await delay(150);
        summary = await readPdfAnnotationSummary(filePath);
    }

    throw new Error(`Packaged smoke annotation was not persisted to the source PDF: ${JSON.stringify(summary)}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(100);
    }
    return !isProcessAlive(pid);
}

async function closeBrowserGracefully(browser: TConnectedBrowser | null) {
    if (!browser) {
        return;
    }
    await Promise.race([
        browser.close().catch(() => {}),
        delay(SHUTDOWN_TIMEOUT_MS),
    ]);
}

async function run() {
    const executablePath = parseExecutablePath(process.argv.slice(2));
    const workDirectory = await mkdtemp(path.join(tmpdir(), 'evb-packaged-core-smoke-'));
    const fixturePath = path.join(workDirectory, 'packaged-core-smoke.pdf');
    const userDataPath = path.join(workDirectory, 'user-data');
    const cdpPort = await findFreePort();
    await createFixturePdf(fixturePath);

    const child = spawn(executablePath, [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataPath}`,
    ], {
        env: {
            ...process.env,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_SESSION_NAME: 'packaged-core-pdf-smoke',
            EVB_AUTOMATION_USER_DATA_DIR: userDataPath,
            EVB_ENABLE_RENDERER_FILE_OPEN_HELPER: '1',
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    let browser: TConnectedBrowser | null = null;
    try {
        const browserWSEndpoint = await waitForCdpEndpoint(cdpPort);
        browser = await puppeteer.connect({
            browserWSEndpoint,
            defaultViewport: null,
            protocolTimeout: 420_000,
        });
        const pages = await browser.pages();
        const page = pages.find(candidate => candidate.url().startsWith('evb-viewer://app/'))
            ?? pages.find(candidate => !candidate.isClosed());
        if (!page) {
            throw new Error('Packaged Electron exposed no renderer page');
        }
        page.on('console', (message) => {
            if (message.type() === 'error' || message.type() === 'warn') {
                console.warn(`[packaged-renderer:${message.type()}] ${message.text()}`);
            }
        });
        page.on('pageerror', error => console.warn('[packaged-renderer:pageerror]', error));

        await installPageEvaluationShims(page);
        await openPdfInApp(page, fixturePath, STARTUP_TIMEOUT_MS);
        await waitForPdfLoaded(page, STARTUP_TIMEOUT_MS);
        await waitForViewerInteractive(page, STARTUP_TIMEOUT_MS);

        await openAnnotationsTab(page, OPERATION_TIMEOUT_MS);
        const annotationText = `Packaged smoke annotation ${Date.now()}`;
        if (await createFreeTextAnnotation(page, annotationText) < 1) {
            throw new Error('Packaged smoke failed to create a FreeText annotation');
        }
        await page.keyboard.press('Escape');
        await waitForSaveEnabled(page);
        await saveViaWindowHandle(page, OPERATION_TIMEOUT_MS);
        await waitForSavedAnnotation(fixturePath, OPERATION_TIMEOUT_MS);

        const workingCopyPath = await getActiveWorkspaceWorkingCopyPath(page);
        const rotateResult = await rotatePages(page, workingCopyPath, [1], 2, 90);
        if (!rotateResult.success) {
            throw new Error('Packaged smoke page rotation failed');
        }
        const rotatedDocument = await PDFDocument.load(await readFile(workingCopyPath), {updateMetadata: false});
        if (rotatedDocument.getPage(0).getRotation().angle !== 90) {
            throw new Error('Packaged smoke page rotation was not persisted to PDF bytes');
        }

        const searchResult = await page.evaluate(async ({pdfPath}) => {
            const api = (window as Window & {electronAPI?: {search?: {run?: (
                pdfPath: string,
                query: string,
            ) => Promise<{results: unknown[]}>;};};}).electronAPI;
            if (!api?.search?.run) {
                throw new Error('electronAPI.search.run is unavailable');
            }
            return api.search.run(pdfPath, 'searchable text');
        }, {pdfPath: workingCopyPath});
        if (searchResult.results.length < 1) {
            throw new Error('Packaged smoke search returned no fixture matches');
        }

        console.log('Packaged core-PDF smoke passed: open, annotation save, rotate persistence, and search.');
    } catch (error) {
        await capturePackagedCorePdfFailureArtifacts(browser, error);
        throw error;
    } finally {
        await closeBrowserGracefully(browser);
        if (typeof child.pid === 'number') {
            await waitForProcessExit(child.pid, 5_000);
        }
        await browser?.disconnect().catch(() => {});
        if (typeof child.pid === 'number') {
            if (isProcessAlive(child.pid)) {
                await killProcessTree(child.pid, 3_000);
            }
        } else if (child.exitCode === null) {
            child.kill('SIGKILL');
        }
        try {
            await rm(workDirectory, {
                force: true,
                maxRetries: 10,
                recursive: true,
                retryDelay: 200,
            });
        } catch (error) {
            console.warn(`Packaged smoke cleanup left temporary files at ${workDirectory}:`, error);
        }
    }
}

await run();
