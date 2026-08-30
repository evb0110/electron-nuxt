import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    mkdir,
    readFile,
    readdir,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {SCAN_CLEANUP_SETTINGS_FILE_NAME} from '@contracts/scanCleanupSettings';
import {createAppTempNamespace} from '@electron/utils/appTempDir';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

/**
 * Opt in explicitly with:
 *
 * EVB_E2E_SCAN_CLEANUP_XLARGE_FIXTURE=.devkit/fixtures/scan-cleanup-138000-pages.pdf \
 *   bash scripts/test-electron-e2e-headless.sh --no-build e2e-xlarge-pdf \
 *   tests/e2e/electron/scanCleanupXlargeAcceptance.e2e.test.ts --reporter verbose
 */

const FIXTURE_ENV = 'EVB_E2E_SCAN_CLEANUP_XLARGE_FIXTURE';
const ARTIFACT_ENV = 'EVB_E2E_SCAN_CLEANUP_XLARGE_ARTIFACT';
const PAGE_COUNT_ENV = 'EVB_E2E_SCAN_CLEANUP_XLARGE_PAGE_COUNT';
const ACCEPTANCE_PAGE_COUNT = 138_000;
// A 60-minute budget for the full document. Measured on the Linux VPS with
// batched Poppler rendering (16 contiguous pages per process): 5,000 pages in
// 53 s (5,626 pages/min) and 25,000 pages in 521 s (2,878 pages/min). The
// floor guards against a fallback to per-page subprocesses (~460 pages/min),
// not against host speed.
const MIN_ANALYSIS_PAGES_PER_MINUTE = ACCEPTANCE_PAGE_COUNT / 60;
const configuredPageCount = Number.parseInt(process.env[PAGE_COUNT_ENV]?.trim() || String(ACCEPTANCE_PAGE_COUNT), 10);
if (!Number.isSafeInteger(configuredPageCount) || configuredPageCount < 1) {
    throw new RangeError(`${PAGE_COUNT_ENV} must be a positive safe integer`);
}
const PAGE_COUNT = configuredPageCount;
const MAIN_RSS_MAX_DELTA_BYTES = 512 * 1_024 * 1_024;
const RENDERER_JS_HEAP_MAX_DELTA_BYTES = 256 * 1_024 * 1_024;
const SETTINGS_MAX_BYTES = 1 * 1_024 * 1_024;
const DETECTION_RECORDS_MAX_BYTES = 512 * 1_024 * 1_024;
const DETECTION_INDEX_BYTES = PAGE_COUNT * 8;
const SAMPLE_INTERVAL_MS = 500;
const OPEN_TIMEOUT_MS = 10 * 60 * 1_000;
const ANALYSIS_TIMEOUT_MS = 8 * 60 * 60 * 1_000;
const TEST_TIMEOUT_MS = 9 * 60 * 60 * 1_000;
const configuredFixture = process.env[FIXTURE_ENV]?.trim() ?? '';
const acceptanceDescribe = configuredFixture && process.platform !== 'win32'
    ? describe
    : describe.skip;
const artifactPath = resolve(
    process.env[ARTIFACT_ENV]?.trim()
        || join('.devkit', 'test', 'electron-e2e-artifacts', 'scan-cleanup-xlarge-acceptance.json'),
);
const execFileAsync = promisify(execFile);

interface IMemorySample {
    atMs: number;
    mainRssBytes: number | null;
    rendererJsHeapUsedBytes: number | null;
}

interface IMemoryTelemetry {
    baselineMainRssBytes: number | null;
    peakMainRssBytes: number | null;
    mainRssDeltaBytes: number | null;
    baselineRendererJsHeapUsedBytes: number | null;
    peakRendererJsHeapUsedBytes: number | null;
    rendererJsHeapDeltaBytes: number | null;
    samples: IMemorySample[];
}

interface IMemorySampler {stop: () => Promise<IMemoryTelemetry>;}

interface IDetectionArtifactTelemetry {
    indexBytes: number;
    recordsBytes: number;
    storeCount: number;
}

interface IRailTelemetry {
    activeSegment: number;
    contentHeightPx: number;
    currentPageMounted: boolean;
    mountedPageCount: number;
    renderedPageCount: number;
    renderedPageMax: number;
}

interface IAcceptanceTelemetry {
    fixture: {
        bytes: number;
        pageCount: number;
        path: string;
        sha256: string;
    };
    analysisDurationMs: number | null;
    analysisPagesPerMinute: number | null;
    analysisStatus: string | null;
    detectionArtifacts: IDetectionArtifactTelemetry | null;
    firstRail: IRailTelemetry | null;
    memory: Array<{
        phase: 'analysis-and-persist' | 'restart-readback';
        telemetry: IMemoryTelemetry;
    }>;
    restartedRail: IRailTelemetry | null;
    settings: {
        bytes: number | null;
        documentEntryCount: number | null;
        overrideCount: number | null;
    };
}

async function readResidentBytes(pid: number | null) {
    if (!pid || process.platform === 'win32') {
        return null;
    }
    try {
        const {stdout} = await execFileAsync('ps', [
            '-o',
            'rss=',
            '-p',
            String(pid),
        ], {encoding: 'utf8'});
        const kib = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(kib) ? kib * 1_024 : null;
    } catch {
        return null;
    }
}

async function readRendererJsHeap(page: Page) {
    try {
        const metrics = await page.metrics();
        return typeof metrics.JSHeapUsedSize === 'number' && Number.isFinite(metrics.JSHeapUsedSize)
            ? metrics.JSHeapUsedSize
            : null;
    } catch {
        return null;
    }
}

function createMemorySampler(page: Page, mainPid: number | null): IMemorySampler {
    const startedAt = performance.now();
    const samples: IMemorySample[] = [];
    let running = true;
    let result: IMemoryTelemetry | null = null;
    const sample = async () => {
        const [
            mainRssBytes,
            rendererJsHeapUsedBytes,
        ] = await Promise.all([
            readResidentBytes(mainPid),
            readRendererJsHeap(page),
        ]);
        if (running) {
            samples.push({
                atMs: Math.round((performance.now() - startedAt) * 10) / 10,
                mainRssBytes,
                rendererJsHeapUsedBytes,
            });
        }
    };
    const loop = (async () => {
        while (running) {
            await sample();
            if (running) {
                await new Promise<void>(resolvePromise => {
                    setTimeout(resolvePromise, SAMPLE_INTERVAL_MS);
                });
            }
        }
    })();
    return {stop: async () => {
        if (result !== null) {
            return result;
        }
        running = false;
        await loop;
        const mainValues = samples
            .map(sampleValue => sampleValue.mainRssBytes)
            .filter((value): value is number => value !== null);
        const heapValues = samples
            .map(sampleValue => sampleValue.rendererJsHeapUsedBytes)
            .filter((value): value is number => value !== null);
        const baselineMainRssBytes = mainValues[0] ?? null;
        const peakMainRssBytes = mainValues.length > 0 ? Math.max(...mainValues) : null;
        const baselineRendererJsHeapUsedBytes = heapValues[0] ?? null;
        const peakRendererJsHeapUsedBytes = heapValues.length > 0 ? Math.max(...heapValues) : null;
        result = {
            baselineMainRssBytes,
            peakMainRssBytes,
            mainRssDeltaBytes: baselineMainRssBytes !== null && peakMainRssBytes !== null
                ? Math.max(0, peakMainRssBytes - baselineMainRssBytes)
                : null,
            baselineRendererJsHeapUsedBytes,
            peakRendererJsHeapUsedBytes,
            rendererJsHeapDeltaBytes: baselineRendererJsHeapUsedBytes !== null
                && peakRendererJsHeapUsedBytes !== null
                ? Math.max(0, peakRendererJsHeapUsedBytes - baselineRendererJsHeapUsedBytes)
                : null,
            samples,
        };
        return result;
    }};
}

async function sha256(path: string) {
    const hash = createHash('sha256');
    await new Promise<void>((resolvePromise, reject) => {
        const stream = createReadStream(path);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolvePromise);
    });
    return hash.digest('hex');
}

async function pollUntil<T>(
    probe: () => Promise<T>,
    accepts: (value: T) => boolean,
    timeoutMs: number,
    intervalMs: number,
) {
    const deadline = Date.now() + timeoutMs;
    let latest = await probe();
    while (!accepts(latest) && Date.now() < deadline) {
        await new Promise<void>(resolvePromise => setTimeout(resolvePromise, intervalMs));
        latest = await probe();
    }
    if (!accepts(latest)) {
        throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for the Electron page state`);
    }
    return latest;
}

async function waitForAnalysisTerminal(page: Page) {
    return pollUntil(
        () => page.evaluate(() => {
            const surface = document.querySelector('.scan-cleanup-surface');
            if (surface === null) {
                const alerts = Array.from(document.querySelectorAll('[role="alert"], [class*="failure"], [class*="error"]'))
                    .map(node => (node.textContent ?? '').trim()).filter(text => text.length > 0).slice(0, 5);
                const body = (document.body.innerText ?? '').replace(/\s+/gu, ' ').slice(0, 600);
                console.warn(`[xlarge-debug] surface missing alerts=${JSON.stringify(alerts)} body=${JSON.stringify(body)}`);
                return null;
            }
            return surface.getAttribute('data-detection-status');
        }),
        status => [
            'completed',
            'failed',
            'canceled',
        ].includes(status ?? ''),
        ANALYSIS_TIMEOUT_MS,
        2_000,
    );
}

async function driveRailToLastPage(page: Page): Promise<IRailTelemetry> {
    const listSelector = '.scan-thumbnail-list[data-testid="document-thumbnail-list"]';
    await page.waitForSelector(listSelector, {
        timeout: OPEN_TIMEOUT_MS,
        visible: true,
    });
    await page.focus(listSelector);
    await page.keyboard.press('End');
    return pollUntil(() => page.$eval(listSelector, (list, lastPage: number) => {
        const content = list.querySelector<HTMLElement>('.document-thumbnail-list__content');
        const currentRow = list.querySelector(`[data-thumbnail-page="${String(lastPage)}"]`);
        const renderedPages = Array.from(list.querySelectorAll<HTMLElement>('[data-thumbnail-page]'))
            .filter(row => row.querySelector('canvas, img'))
            .map(row => Number(row.dataset.thumbnailPage))
            .filter(Number.isFinite);
        return {
            activeSegment: Number(content?.dataset.thumbnailScrollSegment ?? '-1'),
            contentHeightPx: Number.parseFloat(content?.style.height ?? '0'),
            currentPageMounted: currentRow !== null,
            mountedPageCount: list.querySelectorAll('[data-thumbnail-page]').length,
            renderedPageCount: renderedPages.length,
            renderedPageMax: Math.max(0, ...renderedPages),
        };
    }, PAGE_COUNT), value => value.activeSegment >= 0 && value.currentPageMounted, 30_000, 250);
}

async function waitForAriaChecked(page: Page, selector: string, expected: string) {
    return pollUntil(
        () => page.$eval(selector, element => element.getAttribute('aria-checked')),
        value => value === expected,
        30_000,
        250,
    );
}

async function readDetectionArtifacts(sessionName: string): Promise<IDetectionArtifactTelemetry> {
    const userData = electronUserDataPath(sessionName);
    const appTemp = join(tmpdir(), `evb-viewer-${createAppTempNamespace(userData)}`);
    const entries = await readdir(appTemp, {withFileTypes: true});
    const stores = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('scan-cleanup-results-'));
    let indexBytes = 0;
    let recordsBytes = 0;
    for (const store of stores) {
        const root = join(appTemp, store.name);
        indexBytes += (await stat(join(root, 'index.bin'))).size;
        recordsBytes += (await stat(join(root, 'records.jsonl'))).size;
    }
    return {
        indexBytes,
        recordsBytes,
        storeCount: stores.length,
    };
}

async function waitForPersistedOverride(settingsPath: string, sourceSha256: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const raw = await readFile(settingsPath, 'utf8');
            const parsed = JSON.parse(raw) as {documentOverrides?: Record<string, {overrides?: Record<string, {excluded?: boolean}>}>};
            if (parsed.documentOverrides?.[sourceSha256]?.overrides?.[String(PAGE_COUNT)]?.excluded === true) {
                return parsed;
            }
        } catch {
            // The file is published atomically. Retry while the renderer's
            // debounce and main-process write queue settle.
        }
        await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 100));
    }
    throw new Error('The last-page scan-cleanup override did not reach the file-backed settings store');
}

function assertMemoryBudget(telemetry: IMemoryTelemetry) {
    expect(telemetry.samples.length).toBeGreaterThan(0);
    expect(telemetry.mainRssDeltaBytes).not.toBeNull();
    expect(telemetry.mainRssDeltaBytes).toBeLessThanOrEqual(MAIN_RSS_MAX_DELTA_BYTES);
    expect(telemetry.rendererJsHeapDeltaBytes).not.toBeNull();
    expect(telemetry.rendererJsHeapDeltaBytes).toBeLessThanOrEqual(RENDERER_JS_HEAP_MAX_DELTA_BYTES);
}

acceptanceDescribe('scan cleanup xlarge page-source acceptance', () => {
    const fixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-scan-cleanup-xlarge-${Date.now()}`,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
        restartBeforeEach: false,
        timeoutMs: OPEN_TIMEOUT_MS,
    });

    it('keeps analysis, generic page-source navigation, and persistence bounded across restart', async () => {
        const fixturePath = resolve(configuredFixture);
        const fixtureStats = await stat(fixturePath);
        const fixtureSha256 = await sha256(fixturePath);
        const telemetry: IAcceptanceTelemetry = {
            fixture: {
                bytes: fixtureStats.size,
                pageCount: PAGE_COUNT,
                path: fixturePath,
                sha256: fixtureSha256,
            },
            analysisDurationMs: null,
            analysisPagesPerMinute: null,
            analysisStatus: null,
            detectionArtifacts: null,
            firstRail: null,
            memory: [],
            restartedRail: null,
            settings: {
                bytes: null,
                documentEntryCount: null,
                overrideCount: null,
            },
        };
        let activeSampler: IMemorySampler | null = null;
        let activeSamplerPhase: 'analysis-and-persist' | 'restart-readback' = 'analysis-and-persist';
        try {
            const session = fixture.getSession();
            expect(session).toBeTruthy();
            if (!session) {
                return;
            }
            await openPdfInApp(session.page, fixturePath, OPEN_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
            await waitForViewerInteractive(session.page, OPEN_TIMEOUT_MS);
            const pageCount = await session.page.evaluate(() => (
                window.__evbTestApi?.getActiveToolbarSnapshot?.()?.totalPages ?? 0
            ));
            expect(pageCount).toBe(PAGE_COUNT);

            const firstSampler = createMemorySampler(
                session.page,
                getSessionInfo(session.name)?.electronPid ?? null,
            );
            activeSampler = firstSampler;
            const analysisStartedAt = performance.now();
            await clickVisibleToolbarButton(session.page, 'Scan cleanup');
            await session.page.waitForSelector('.scan-cleanup-surface', {
                timeout: OPEN_TIMEOUT_MS,
                visible: true,
            });
            telemetry.firstRail = await driveRailToLastPage(session.page);
            expect(telemetry.firstRail.mountedPageCount).toBeLessThanOrEqual(40);
            if (PAGE_COUNT === ACCEPTANCE_PAGE_COUNT) {
                expect(telemetry.firstRail.activeSegment).toBeGreaterThan(0);
            }
            expect(telemetry.firstRail.contentHeightPx).toBeGreaterThan(0);
            expect(telemetry.firstRail.contentHeightPx).toBeLessThanOrEqual(16_000_000);
            expect(telemetry.firstRail.currentPageMounted).toBe(true);

            telemetry.analysisStatus = await waitForAnalysisTerminal(session.page);
            const detectionErrorText = await session.page.evaluate(() => JSON.stringify(Array.from(document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [class*="error"]')).map(node => (node.textContent ?? '').trim()).filter(text => text.length > 0).slice(0, 6))).catch(() => 'n/a');
            process.stdout.write(`[xlarge-debug] detectionStatus=${String(telemetry.analysisStatus)} alerts=${detectionErrorText}\n`);
            telemetry.analysisDurationMs = Math.round((performance.now() - analysisStartedAt) * 10) / 10;
            telemetry.analysisPagesPerMinute = PAGE_COUNT * 60_000 / telemetry.analysisDurationMs;
            expect(telemetry.analysisStatus).toBe('completed');
            expect(telemetry.analysisPagesPerMinute).toBeGreaterThan(MIN_ANALYSIS_PAGES_PER_MINUTE);
            telemetry.detectionArtifacts = await readDetectionArtifacts(session.name);
            expect(telemetry.detectionArtifacts.storeCount).toBe(1);
            expect(telemetry.detectionArtifacts.indexBytes).toBe(DETECTION_INDEX_BYTES);
            expect(telemetry.detectionArtifacts.recordsBytes).toBeGreaterThan(PAGE_COUNT);
            expect(telemetry.detectionArtifacts.recordsBytes).toBeLessThanOrEqual(DETECTION_RECORDS_MAX_BYTES);

            const lastPageToggle = `[data-page-number="${String(PAGE_COUNT)}"] .scan-thumbnail-exclude-toggle`;
            await session.page.click(lastPageToggle);
            await waitForAriaChecked(session.page, lastPageToggle, 'false');
            const settingsPath = join(electronUserDataPath(session.name), SCAN_CLEANUP_SETTINGS_FILE_NAME);
            const persisted = await waitForPersistedOverride(settingsPath, fixtureSha256);
            const persistedStats = await stat(settingsPath);
            telemetry.settings = {
                bytes: persistedStats.size,
                documentEntryCount: Object.keys(persisted.documentOverrides ?? {}).length,
                overrideCount: Object.keys(
                    persisted.documentOverrides?.[fixtureSha256]?.overrides ?? {},
                ).length,
            };
            expect(telemetry.settings.bytes).toBeLessThanOrEqual(SETTINGS_MAX_BYTES);
            expect(telemetry.settings.documentEntryCount).toBe(1);
            expect(telemetry.settings.overrideCount).toBe(1);

            const firstMemory = await firstSampler.stop();
            activeSampler = null;
            telemetry.memory.push({
                phase: 'analysis-and-persist',
                telemetry: firstMemory,
            });
            assertMemoryBudget(firstMemory);

            const restarted = await fixture.restart({
                clean: false,
                hard: true,
                keepNuxt: true,
            });
            expect(restarted).toBeTruthy();
            if (!restarted) {
                return;
            }
            const restartedSampler = createMemorySampler(
                restarted.page,
                getSessionInfo(restarted.name)?.electronPid ?? null,
            );
            activeSampler = restartedSampler;
            activeSamplerPhase = 'restart-readback';
            await waitForPdfLoaded(restarted.page, OPEN_TIMEOUT_MS);
            await waitForViewerInteractive(restarted.page, OPEN_TIMEOUT_MS);
            const hasSurface = await restarted.page.$('.scan-cleanup-surface');
            if (!hasSurface) {
                await clickVisibleToolbarButton(restarted.page, 'Scan cleanup');
            }
            await restarted.page.waitForSelector('.scan-cleanup-surface', {
                timeout: OPEN_TIMEOUT_MS,
                visible: true,
            });
            telemetry.restartedRail = await driveRailToLastPage(restarted.page);
            expect(telemetry.restartedRail.mountedPageCount).toBeLessThanOrEqual(40);
            expect(telemetry.restartedRail.currentPageMounted).toBe(true);
            const restartedToggle = `[data-page-number="${String(PAGE_COUNT)}"] .scan-thumbnail-exclude-toggle`;
            await waitForAriaChecked(restarted.page, restartedToggle, 'false');
            const restartedMemory = await restartedSampler.stop();
            activeSampler = null;
            telemetry.memory.push({
                phase: 'restart-readback',
                telemetry: restartedMemory,
            });
            assertMemoryBudget(restartedMemory);
        } finally {
            if (activeSampler !== null) {
                const failureMemory = await activeSampler.stop();
                telemetry.memory.push({
                    phase: activeSamplerPhase,
                    telemetry: failureMemory,
                });
            }
            await mkdir(dirname(artifactPath), {recursive: true});
            await writeFile(artifactPath, `${JSON.stringify(telemetry, null, 2)}\n`, 'utf8');
        }
    }, TEST_TIMEOUT_MS);
});
