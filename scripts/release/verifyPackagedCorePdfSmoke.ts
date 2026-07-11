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
import {findFreePort} from '@scripts/electron-run/electronRunProcessTree';
import {
    getActiveWorkspaceWorkingCopyPath,
    rotatePages,
} from '@tests/e2e/electron/helpers/electronApiHelpers';
import {
    openAnnotationsTab,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {createFreeTextAnnotation} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readPdfAnnotationSummary} from '@tests/e2e/electron/helpers/fixtures';

const STARTUP_TIMEOUT_MS = 75_000;
const OPERATION_TIMEOUT_MS = 45_000;

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

async function clickSave(page: Page) {
    const clicked = await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => candidate.getAttribute('aria-label')?.trim() === 'Save' && !candidate.disabled);
        button?.click();
        return Boolean(button);
    });
    if (!clicked) {
        throw new Error('Packaged smoke could not find the enabled Save toolbar button');
    }
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

    let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;
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
        const saveBaselineEventId = await getLatestAutomationEventId(page);
        const saveCommitted = waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            path: fixturePath,
            timeoutMs: OPERATION_TIMEOUT_MS,
        });
        await clickSave(page);
        await saveCommitted;
        const annotationSummary = await readPdfAnnotationSummary(fixturePath);
        if ((annotationSummary.bySubtype.FreeText ?? 0) < 1) {
            throw new Error('Packaged smoke annotation was not persisted to the source PDF');
        }

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

        console.log('Packaged Linux core-PDF smoke passed: open, annotation save, rotate persistence, and search.');
    } finally {
        await browser?.disconnect().catch(() => {});
        if (child.exitCode === null) {
            child.kill('SIGTERM');
        }
        await rm(workDirectory, {
            force: true,
            recursive: true,
        });
    }
}

await run();
