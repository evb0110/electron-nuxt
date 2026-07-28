import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRawStream,
} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import {devServerOutputTeeBaseDir} from '@scripts/electron-run/devServerOutputTee';
import {sessionLogFilePath} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createMixedScaleScannedFixturePdf,
    createSpreadScannedFixturePdf,
    createVariedContentScannedFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';

const SOURCE_PAGE_WIDTH_POINTS = 612;
const SOURCE_PAGE_HEIGHT_POINTS = 792;
// The finest resolution the mixed-scale fixture was scanned at, which is the
// grid its cleaned document has to carry — its other pages arrived at half of
// it (see createMixedScaleScannedFixturePdf).
const SOURCE_HIGH_DPI = 288;
// The document is normalized onto a rectangle it actually carries. The default
// 5 mm margins are laid out inside that rectangle, so a Letter document stays
// Letter rather than growing to 640 x 820.
const CANVAS_WIDTH_POINTS = SOURCE_PAGE_WIDTH_POINTS;
const CANVAS_HEIGHT_POINTS = SOURCE_PAGE_HEIGHT_POINTS;
// Every sampled page has to settle within this, detection running or not.
const PAGE_SETTLE_TIMEOUT_MS = 120_000;
// A cleanup run of these fixtures is seconds of native work. This is the point
// past which "still working" stops being a slow run and starts being a product
// that never finishes.
const RUN_TIMEOUT_MS = 180_000;
// The renderer has to answer a trivial DOM read while the job runs; anything
// past this is the main thread being held by background work.
const RENDERER_LATENCY_BUDGET_MS = 1_000;
const EVIDENCE_DIR = resolve(process.cwd(), '.devkit', '_tasks', 'audit-jul-25', 'u53-evidence');

interface IPreviewFrame {
    width: number;
    height: number;
    renderDpi: number;
    contentWidth: number;
    contentHeight: number;
    sourceRegionWidth: number;
    inputWidth: number;
}

interface ICanvasSample {
    page: number;
    detecting: boolean;
    frames: IPreviewFrame[];
    visibleInMs?: number;
    settledInMs: number;
}

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-scan-cleanup-matched-canvas-${Date.now()}`,
    windowMode: 'hidden',
});

// The sheet a page is presented on, which is what "one document canvas" means.
// The content box on it is a per-page measurement, asserted separately.
function frameKey(frames: IPreviewFrame[]) {
    return JSON.stringify(frames.map(frame => ({
        width: frame.width,
        height: frame.height,
    })));
}

function writeEvidence(name: string, payload: unknown) {
    mkdirSync(EVIDENCE_DIR, {recursive: true});
    writeFileSync(`${EVIDENCE_DIR}/${name}`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readIfPresent(path: string) {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

// Everything this session wrote: the supervisor log and every tee'd main and
// launcher stream, which is where an IPC handler failure lands.
function sessionOutput(sessionName: string) {
    const teeRoot = join(devServerOutputTeeBaseDir, sessionName);
    const runDirs = existsSync(teeRoot)
        ? readdirSync(teeRoot, {withFileTypes: true}).filter(entry => entry.isDirectory())
        : [];
    return [
        readIfPresent(sessionLogFilePath(sessionName)),
        ...runDirs.flatMap(runDir => readdirSync(join(teeRoot, runDir.name))
            .filter(name => name.endsWith('.log'))
            .map(name => readIfPresent(join(teeRoot, runDir.name, name)))),
    ].join('\n');
}

// Anything the main process logged as a failure of this feature. A cancelled
// preview is an ordinary result, so none of these may appear at all.
function scanCleanupLogFailures(sessionName: string) {
    return sessionOutput(sessionName).split(/\r?\n/u).filter(line => line.includes('NativeScanCleanupError')
        || line.includes('os error 2')
        || /Error occurred in handler for 'scan-cleanup/u.test(line));
}

// The raster each output page embeds. A document normalized onto one grid
// writes the same pixel dimensions, at the same DPI, on every page.
function outputPageRasters(document: PDFDocument) {
    return document.getPages().map(page => {
        const size = page.getSize();
        const resources = page.node.Resources();
        const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        const entries = xObjects?.entries() ?? [];
        const images = entries.flatMap(entry => {
            const reference = entry[1];
            const stream = document.context.lookup(reference);
            if (!(stream instanceof PDFRawStream)) {
                return [];
            }
            const widthPx = stream.dict.get(PDFName.of('Width'));
            const heightPx = stream.dict.get(PDFName.of('Height'));
            return widthPx === undefined || heightPx === undefined
                ? []
                : [{
                    widthPx: Number(widthPx.toString()),
                    heightPx: Number(heightPx.toString()),
                }];
        });
        return {
            widthPoints: Math.round(size.width * 100) / 100,
            heightPoints: Math.round(size.height * 100) / 100,
            images,
        };
    });
}

async function openScanCleanup(page: Page, sourcePath: string) {
    // The file shares one real Electron window across scenarios. A preceding
    // scenario can intentionally leave the cleanup workspace open after it
    // verifies its output; reset that feature mode before opening the next
    // source so toolbar discovery measures the new document rather than the
    // previous workspace's specialized toolbar.
    if (await page.$('.scan-cleanup-surface')) {
        await page.click('.scan-cleanup-toolbar-done');
        await page.waitForSelector('.scan-cleanup-surface', {
            hidden: true,
            timeout: 30_000,
        });
    }
    await openPdfInApp(page, sourcePath, 180_000);
    await waitForPdfLoaded(page, 180_000);
    await waitForViewerInteractive(page, 180_000);
    await waitForFunctionInPage(page, () => {
        const toolbar = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.();
        return toolbar?.initialVisualReady === true && toolbar.totalPages > 0;
    }, {timeout: 180_000});
    await clickVisibleToolbarButton(page, 'Scan cleanup');
    await page.waitForSelector('.scan-cleanup-surface', {
        timeout: 30_000,
        visible: true,
    });
}

// The cleaned canvas publishes the frame it presents, so a sample is the
// geometry the user sees rather than a screenshot heuristic.
const readFrames = (page: Page) => evaluateInPage(page, () => Array.from(
    document.querySelectorAll<HTMLElement>(
        '.cleaned-outputs.is-visible .uniform-canvas[data-frame-width]:not(.preview-skeleton-page)',
    ),
).map(element => {
    const placed = element.querySelector<HTMLElement>('.placed-image[data-content-width]');
    return {
        width: Number(element.dataset.frameWidth),
        height: Number(element.dataset.frameHeight),
        renderDpi: Number(element.dataset.renderDpi),
        contentWidth: Number(placed?.dataset.contentWidth ?? 0),
        contentHeight: Number(placed?.dataset.contentHeight ?? 0),
        sourceRegionWidth: Number(placed?.dataset.sourceRegionWidth ?? 0),
        inputWidth: Number(placed?.dataset.inputWidth ?? 0),
    };
})) as Promise<IPreviewFrame[]>;

const readDetecting = (page: Page) => evaluateInPage(page, () => document.querySelector(
    '.scan-cleanup-toolbar-cancel-detection',
) !== null) as Promise<boolean>;

// A page turn updates the counter immediately and keeps the previous page's
// pixels under a loading overlay until its own render lands, so the sample has
// to wait for the overlay to go before it reads a frame.
async function waitForPreview(
    page: Page,
    expectedPage: number,
    timeoutMs = PAGE_SETTLE_TIMEOUT_MS,
) {
    await waitForFunctionInPage(page, (target: number) => {
        const label = document.querySelector(
            '.page-navigation .page-label .scan-cleanup-stable-width-value',
        )?.textContent ?? '';
        const settled = document.querySelector('.page-loading-overlay, .preview-loading, .refresh-indicator') === null;
        return label.trim().startsWith(`Page ${target} of`)
            && settled
            && document.querySelectorAll(
                '.cleaned-outputs.is-visible .uniform-canvas[data-frame-width]:not(.preview-skeleton-page)',
            ).length > 0;
    }, {timeout: timeoutMs}, expectedPage);
}

// The source raster is streamed before native cleanup finishes. This is the
// latency the user feels: a page may still be acquiring cleaned geometry, but
// it may not remain an empty skeleton while that work runs.
async function waitForVisibleRaster(
    page: Page,
    expectedPage: number,
    timeoutMs = 5_000,
) {
    await waitForFunctionInPage(page, (target: number) => {
        const label = document.querySelector(
            '.page-navigation .page-label .scan-cleanup-stable-width-value',
        )?.textContent ?? '';
        const rawImages = Array.from(document.querySelectorAll<HTMLImageElement>(
            '[data-testid="scan-cleanup-original-only"] img.preview-pixel',
        ));
        const rawLoaded = rawImages.some(image => image.complete && image.naturalWidth > 0);
        const sourcePlaceholder = document.querySelector<HTMLElement>(
            '[data-testid="scan-cleanup-source-placeholder"]',
        );
        const placeholderCanvas = sourcePlaceholder?.querySelector<HTMLCanvasElement>('canvas');
        const placeholderImage = sourcePlaceholder?.querySelector<HTMLImageElement>('img');
        const placeholderLoaded = (
            (placeholderCanvas?.width ?? 0) > 0
            && (placeholderCanvas?.height ?? 0) > 0
        ) || (
            placeholderImage?.complete === true
            && placeholderImage.naturalWidth > 0
        );
        const cleanedVisible = document.querySelectorAll(
            '.uniform-canvas[data-frame-width]:not(.preview-skeleton-page)',
        ).length > 0 && document.querySelector('.page-loading-overlay, .preview-loading') === null;
        return label.trim().startsWith(`Page ${target} of`)
            && (placeholderLoaded || rawLoaded || cleanedVisible);
    }, {timeout: timeoutMs}, expectedPage);
}

const nextPage = (page: Page) => evaluateInPage(page, () => {
    const next = document.querySelector<HTMLButtonElement>('.page-navigation button:last-of-type');
    next?.click();
    return next !== null;
});

const readPageNumber = (page: Page) => evaluateInPage(page, () => Number(/Page (\d+) of/u.exec(
    document.querySelector('.page-navigation .page-label .scan-cleanup-stable-width-value')?.textContent ?? '',
)?.[1] ?? 0)) as Promise<number>;

async function sampleWalk(page: Page, startPage: number, steps: number) {
    const samples: ICanvasSample[] = [];
    for (let current = await readPageNumber(page); current < startPage; current += 1) await nextPage(page);
    for (let index = 0; index < steps; index += 1) {
        const pageNumber = startPage + index;
        const startedAtMs = Date.now();
        await waitForPreview(page, pageNumber);
        samples.push({
            page: pageNumber,
            detecting: await readDetecting(page),
            frames: await readFrames(page),
            settledInMs: Date.now() - startedAtMs,
        });
        if (index < steps - 1) await nextPage(page);
    }
    return samples;
}

// The settings panel renders Nuxt UI checkboxes, which expose their state on a
// role="checkbox" control rather than on a native input on every variant.
const CHECKBOX_SELECTOR = 'input[type="checkbox"],[role="checkbox"]';

const toggleCheckbox = (page: Page, text: string) => evaluateInPage(page, (
    selector: string,
    label: string,
) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(element => {
        const named = Array.from((element as HTMLInputElement).labels ?? [])
            .map(item => item.textContent ?? '')
            .join(' ');
        const described = element.closest('div')?.textContent ?? '';
        return `${named} ${described}`.includes(label);
    });
    target?.click();
    return target !== undefined;
}, CHECKBOX_SELECTOR, text);

const readCheckboxes = (page: Page) => evaluateInPage(page, (selector: string) => Array.from(
    document.querySelectorAll<HTMLElement>(selector),
).map(element => ({
    label: `${Array.from((element as HTMLInputElement).labels ?? [])
        .map(item => item.textContent ?? '')
        .join(' ')} ${element.closest('div')?.textContent ?? ''}`.replaceAll(/\s+/gu, ' ').trim(),
    checked: element.getAttribute('aria-checked') === 'true'
        || (element as HTMLInputElement).checked === true
        || element.dataset.state === 'checked',
})), CHECKBOX_SELECTOR) as Promise<Array<{
    label: string;
    checked: boolean;
}>>;

async function expectChecked(page: Page, label: string) {
    const checkboxes = await readCheckboxes(page);
    const matching = checkboxes.filter(checkbox => checkbox.label.includes(label));
    expect(matching.length, `no checkbox labelled "${label}" in ${JSON.stringify(checkboxes)}`)
        .toBeGreaterThan(0);
    expect(matching.every(checkbox => checkbox.checked)).toBe(true);
}

// Scan cleanup settings are global preferences shared by every document in the
// profile, so a test that needs one on turns it on rather than assuming the
// test before it left it that way.
async function ensureChecked(page: Page, label: string) {
    const checkboxes = await readCheckboxes(page);
    const matching = checkboxes.filter(checkbox => checkbox.label.includes(label));
    expect(matching.length, `no checkbox labelled "${label}" in ${JSON.stringify(checkboxes)}`)
        .toBeGreaterThan(0);
    if (matching.every(checkbox => checkbox.checked)) {
        return;
    }
    expect(await toggleCheckbox(page, label)).toBe(true);
    await expectChecked(page, label);
}

// Everything a cleanup run publishes into the UI while it works: the phase it
// reports, whether it is still running, whether it failed, and which document
// the workspace is showing.
const readRunState = (page: Page) => evaluateInPage(page, () => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? '';
    const active = (window as IWorkspaceExposeProbeWindow)
        .__evbTestApi
        ?.readActiveWorkspaceStateValues?.(['originalPath']);
    return {
        originalPath: typeof active?.originalPath === 'string' ? active.originalPath : '',
        error: text('.scan-cleanup-error'),
        phase: text('.scan-cleanup-run-meter-phase'),
        percent: text('.scan-cleanup-run-meter-percent'),
        running: document.querySelector('.scan-cleanup-run-meter') !== null,
    };
}) as Promise<{
    originalPath: string;
    error: string;
    phase: string;
    percent: string;
    running: boolean;
}>;

interface IRendererHeartbeatWindow extends Window {__scanCleanupRendererHeartbeat?: {
    intervalId: number;
    maxGapMs: number;
};}

async function startRendererHeartbeat(page: Page) {
    await evaluateInPage(page, () => {
        const target = window as IRendererHeartbeatWindow;
        const intervalMs = 100;
        let previousAtMs = performance.now();
        const heartbeat = {
            intervalId: 0,
            maxGapMs: 0,
        };
        heartbeat.intervalId = window.setInterval(() => {
            const currentAtMs = performance.now();
            heartbeat.maxGapMs = Math.max(
                heartbeat.maxGapMs,
                currentAtMs - previousAtMs - intervalMs,
            );
            previousAtMs = currentAtMs;
        }, intervalMs);
        target.__scanCleanupRendererHeartbeat = heartbeat;
    });
}

async function stopRendererHeartbeat(page: Page) {
    return evaluateInPage(page, () => {
        const target = window as IRendererHeartbeatWindow;
        const heartbeat = target.__scanCleanupRendererHeartbeat;
        if (!heartbeat) {
            return Number.POSITIVE_INFINITY;
        }
        window.clearInterval(heartbeat.intervalId);
        delete target.__scanCleanupRendererHeartbeat;
        return heartbeat.maxGapMs;
    }) as Promise<number>;
}

/**
 * The cleaned document, or a failure that names what actually happened. A run
 * that fails says so inline; waiting for an output path that will never appear
 * turns a one-second product failure into a silent multi-minute timeout, so
 * this stops on the error instead. Every sample also measures how long the
 * renderer took to answer, which is the responsiveness the user feels while
 * the background job runs.
 */
async function waitForCleanedOutput(page: Page, sourcePath: string, timeoutMs: number) {
    const startedAtMs = Date.now();
    const samples: Array<{
        atMs: number;
        latencyMs: number;
        phase: string;
        percent: string;
    }> = [];
    let last = '';
    while (Date.now() - startedAtMs < timeoutMs) {
        const polledAtMs = Date.now();
        const state = await readRunState(page);
        samples.push({
            atMs: polledAtMs - startedAtMs,
            latencyMs: Date.now() - polledAtMs,
            phase: state.phase,
            percent: state.percent,
        });
        if (state.error) {
            throw new Error(`Scan cleanup failed after ${String(Date.now() - startedAtMs)} ms: ${state.error}`);
        }
        if (
            state.originalPath !== ''
            && state.originalPath !== sourcePath
            // A run over a selection publishes its own name, and waiting only
            // for the whole-document one turns a finished run into a timeout.
            && /— cleaned( selection)?\.pdf$/u.test(state.originalPath)
        ) {
            return {
                outputPath: state.originalPath,
                elapsedMs: Date.now() - startedAtMs,
                samples,
            };
        }
        last = `${state.phase} ${state.percent} running=${String(state.running)}`;
        await new Promise(settle => setTimeout(settle, 500));
    }
    throw new Error(`No cleaned document within ${String(timeoutMs)} ms; last reported: ${last}`);
}

// The ordinary viewer behind the workspace: it must still show a rendered page
// rather than an empty surface or a stalled preparation banner.
const readViewerState = (page: Page) => evaluateInPage(page, () => {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.page_canvas canvas, canvas'));
    return {
        renderedCanvases: canvases.filter(canvas => canvas.width > 0 && canvas.height > 0).length,
        preparing: (document.body.textContent ?? '').includes('Preparing document'),
    };
}) as Promise<{
    renderedCanvases: number;
    preparing: boolean;
}>;

const readCaptionLayout = (page: Page) => evaluateInPage(page, () => {
    const caption = document.querySelector<HTMLElement>('.preview-viewport-caption');
    return {
        display: caption ? getComputedStyle(caption).display : '',
        text: caption?.textContent?.trim() ?? '',
        hasIcon: caption?.querySelector('.iconify') !== null,
    };
});

describe('scan cleanup matched page canvas', () => {
    const representativePdfPath = process.env.EVB_E2E_SCAN_CLEANUP_PDF?.trim();
    const representativeIt = representativePdfPath ? it : it.skip;

    representativeIt('keeps a representative large scan interactive and cleans one selected page', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session || !representativePdfPath) {
            return;
        }
        expect(existsSync(representativePdfPath)).toBe(true);
        const {page} = session;
        await openScanCleanup(page, representativePdfPath);
        await ensureChecked(page, 'Match page size');

        const previewSamples: Array<{
            page: number;
            detecting: boolean;
            visibleInMs: number;
            settledInMs: number;
            frames: IPreviewFrame[];
            caption: Awaited<ReturnType<typeof readCaptionLayout>>;
        }> = [];
        for (const targetPage of [
            1,
            5,
            10,
            12,
        ]) {
            while (await readPageNumber(page) < targetPage) {
                expect(await nextPage(page)).toBe(true);
            }
            const startedAtMs = Date.now();
            await waitForVisibleRaster(page, targetPage);
            const visibleInMs = Date.now() - startedAtMs;
            await waitForPreview(page, targetPage, 15_000);
            previewSamples.push({
                page: targetPage,
                detecting: await readDetecting(page),
                visibleInMs,
                settledInMs: Date.now() - startedAtMs,
                frames: await readFrames(page),
                caption: await readCaptionLayout(page),
            });
        }

        // Detection is independent background enrichment. Cancel it here so
        // the selected-page benchmark measures cleanup itself rather than
        // waiting for a deliberate whole-document scan to finish.
        if (await readDetecting(page)) {
            await page.click('.scan-cleanup-toolbar-cancel-detection');
            await waitForFunctionInPage(page, () => document.querySelector(
                '.scan-cleanup-toolbar-cancel-detection',
            ) === null, {timeout: 30_000});
        }
        expect(await evaluateInPage(page, () => {
            const scope = document.querySelector<HTMLElement>('[data-settings-scope="page"]');
            scope?.click();
            return scope !== null;
        })).toBe(true);
        await waitForFunctionInPage(page, () => (document.querySelector(
            '.scan-cleanup-toolbar-primary-action',
        )?.textContent ?? '').includes('page'), {timeout: 30_000});

        await page.click('.scan-cleanup-toolbar-primary-action');
        const run = await waitForCleanedOutput(page, representativePdfPath, RUN_TIMEOUT_MS);
        await waitForPdfLoaded(page, 60_000);
        await waitForViewerInteractive(page, 60_000);
        const viewer = await readViewerState(page);
        const outputPages = outputPageRasters(await PDFDocument.load(readFileSync(run.outputPath)));
        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('representative-large-scan.json', {
            sourcePath: representativePdfPath,
            previewSamples,
            runElapsedMs: run.elapsedMs,
            runSamples: run.samples,
            outputPages,
            viewer,
            logFailures,
        });

        expect(previewSamples.some(sample => sample.detecting)).toBe(true);
        expect(Math.max(...previewSamples.map(sample => sample.visibleInMs))).toBeLessThan(5_000);
        expect(Math.max(...previewSamples.map(sample => sample.settledInMs))).toBeLessThan(15_000);
        expect(new Set(previewSamples.map(sample => frameKey(sample.frames))).size).toBe(1);
        const twoColumnPage = previewSamples.find(sample => sample.page === 10);
        expect(twoColumnPage?.frames).toHaveLength(1);
        expect(twoColumnPage!.frames[0]!.sourceRegionWidth / twoColumnPage!.frames[0]!.inputWidth)
            .toBeGreaterThan(0.9);
        for (const sample of previewSamples.filter(candidate => candidate.caption.text !== '')) {
            expect(sample.caption.display).toBe('flex');
            expect(sample.caption.hasIcon).toBe(false);
        }
        expect(outputPages).toHaveLength(1);
        expect(viewer.preparing).toBe(false);
        expect(viewer.renderedCanvases).toBeGreaterThan(0);
        expect(logFailures).toEqual([]);
    }, 600_000);

    it('presents one document canvas before, during and after detection', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const pageCount = 240;
        await openScanCleanup(page, await createVariedContentScannedFixturePdf(
            'scan-cleanup-matched-canvas-large.pdf',
            pageCount,
        ));
        await expectChecked(page, 'Crop each output page');
        await expectChecked(page, 'Match page size');

        // Reading a scan of this size takes minutes, which is the whole window
        // in which the preview used to crop every page to its own content.
        const duringDetection = await sampleWalk(page, 1, 22);
        await waitForFunctionInPage(page, () => document.querySelector(
            '.scan-cleanup-toolbar-cancel-detection',
        ) === null, {timeout: 900_000});
        const afterDetection = await sampleWalk(page, 23, 6);

        expect(await toggleCheckbox(page, 'Match page size')).toBe(true);
        const unmatched = await sampleWalk(page, 29, 6);

        // Put the shared preference back before anything else runs against it,
        // and prove that turning matching on again restores the one canvas.
        expect(await toggleCheckbox(page, 'Match page size')).toBe(true);
        const rematched = await sampleWalk(page, 35, 2);

        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-walk.json', {
            pageCount,
            duringDetection,
            afterDetection,
            unmatched,
            rematched,
            logFailures,
        });

        const matched = [
            ...duringDetection,
            ...afterDetection,
        ];
        expect(duringDetection.filter(sample => sample.detecting).length).toBeGreaterThan(0);
        expect(matched.filter(sample => !sample.detecting).length).toBeGreaterThan(0);
        // Matching on: the same canvas for every page, on both sides of the
        // detection boundary. Not one canvas while the job runs and another
        // once it lands — one canvas.
        expect(new Set(matched.map(sample => frameKey(sample.frames))).size).toBe(1);
        // And it is the document canvas plan, which is what the run writes:
        // the page rectangle the document carries, not one grown by margins.
        expect(matched[0]!.frames).toHaveLength(1);
        expect(Math.abs(
            matched[0]!.frames[0]!.width / matched[0]!.frames[0]!.renderDpi * 72
            - CANVAS_WIDTH_POINTS,
        )).toBeLessThanOrEqual(1);
        expect(Math.abs(
            matched[0]!.frames[0]!.height / matched[0]!.frames[0]!.renderDpi * 72
            - CANVAS_HEIGHT_POINTS,
        )).toBeLessThanOrEqual(1);
        // No page waits on work that cannot be admitted while detection runs.
        expect(Math.max(...matched.map(sample => sample.settledInMs)))
            .toBeLessThan(PAGE_SETTLE_TIMEOUT_MS);
        // Matching on, every page of this document is the same paper, so its
        // cropped content keeps its own size inside the shared sheet rather
        // than being zoomed to fill it.
        for (const sample of matched) {
            for (const frame of sample.frames) {
                expect(frame.contentWidth).toBeGreaterThan(0);
                expect(frame.contentWidth).toBeLessThanOrEqual(frame.width);
                expect(frame.contentHeight).toBeLessThanOrEqual(frame.height);
            }
        }
        // Matching off: content-cropped pages keep their own dimensions, and
        // the same page that shared a canvas above now crops to itself.
        expect(new Set(unmatched.map(sample => frameKey(sample.frames))).size).toBeGreaterThan(2);
        expect(frameKey(unmatched[0]!.frames)).not.toBe(frameKey(matched[0]!.frames));
        expect(frameKey(rematched[0]!.frames)).toBe(frameKey(matched[0]!.frames));
        expect(logFailures).toEqual([]);
    }, 1_800_000);

    it('generates a document whose pages carry the canvas the preview presented', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const pageCount = 8;
        const sourcePath = await createVariedContentScannedFixturePdf(
            'scan-cleanup-matched-canvas-output.pdf',
            pageCount,
        );
        await openScanCleanup(page, sourcePath);
        await ensureChecked(page, 'Match page size');
        await waitForFunctionInPage(page, () => document.querySelector(
            '.scan-cleanup-toolbar-cancel-detection',
        ) === null, {timeout: 900_000});
        await waitForPreview(page, 1);
        const previewFrames = await readFrames(page);
        const previewCanvasPoints = {
            widthPoints: (previewFrames[0]?.width ?? 0) / (previewFrames[0]?.renderDpi ?? 1) * 72,
            heightPoints: (previewFrames[0]?.height ?? 0) / (previewFrames[0]?.renderDpi ?? 1) * 72,
        };

        await page.click('.scan-cleanup-toolbar-primary-action');
        const run = await waitForCleanedOutput(page, sourcePath, RUN_TIMEOUT_MS);
        const outputPath = run.outputPath;
        // The generated document is what the user is left looking at, so it has
        // to be open and rendering rather than a blank or preparing surface.
        await waitForPdfLoaded(page, 180_000);
        await waitForViewerInteractive(page, 180_000);
        const viewer = await readViewerState(page);
        const output = await PDFDocument.load(readFileSync(outputPath));
        const outputPages = outputPageRasters(output);
        const outputSizes = outputPages.map(({
            widthPoints,
            heightPoints,
        }) => ({
            widthPoints,
            heightPoints,
        }));

        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-output.json', {
            pageCount,
            previewFrames,
            previewCanvasPoints,
            outputSizes,
            outputPages,
            viewer,
            runElapsedMs: run.elapsedMs,
            runSamples: run.samples,
            logFailures,
        });
        expect(run.elapsedMs).toBeLessThan(RUN_TIMEOUT_MS);

        expect(outputSizes).toHaveLength(pageCount);
        expect(new Set(outputSizes.map(size => JSON.stringify(size))).size).toBe(1);
        // Absolute, not proportional: every page is the rectangle the preview
        // presented, to within a point.
        expect(Math.abs(outputSizes[0]!.widthPoints - previewCanvasPoints.widthPoints))
            .toBeLessThanOrEqual(1);
        expect(Math.abs(outputSizes[0]!.heightPoints - previewCanvasPoints.heightPoints))
            .toBeLessThanOrEqual(1);
        expect(Math.abs(outputSizes[0]!.widthPoints - CANVAS_WIDTH_POINTS)).toBeLessThanOrEqual(1);
        expect(Math.abs(outputSizes[0]!.heightPoints - CANVAS_HEIGHT_POINTS)).toBeLessThanOrEqual(1);
        expect(viewer.preparing).toBe(false);
        expect(viewer.renderedCanvases).toBeGreaterThan(0);
        expect(logFailures).toEqual([]);
    }, 1_800_000);

    it('scales a lower-resolution scan of the same original onto the document grid', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const pageCount = 6;
        const sourcePath = await createMixedScaleScannedFixturePdf(
            'scan-cleanup-matched-canvas-mixed-scale.pdf',
            pageCount,
        );
        await openScanCleanup(page, sourcePath);
        await ensureChecked(page, 'Match page size');
        await waitForFunctionInPage(page, () => document.querySelector(
            '.scan-cleanup-toolbar-cancel-detection',
        ) === null, {timeout: 900_000});

        // Page 1 is the 288 DPI Letter scan, page 2 the same Letter paper at
        // 144, and page 3 the same original at 144 carried as a half-size page.
        const sampled = await sampleWalk(page, 1, 3);
        const [
            full,
            coarse,
            half,
        ] = sampled;

        await page.click('.scan-cleanup-toolbar-primary-action');
        const run = await waitForCleanedOutput(page, sourcePath, RUN_TIMEOUT_MS);
        await waitForPdfLoaded(page, 180_000);
        await waitForViewerInteractive(page, 180_000);
        const viewer = await readViewerState(page);
        const output = await PDFDocument.load(readFileSync(run.outputPath));
        const outputPages = outputPageRasters(output);
        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-mixed-scale.json', {
            pageCount,
            sampled,
            outputPages,
            viewer,
            runElapsedMs: run.elapsedMs,
            runSamples: run.samples,
            logFailures,
        });
        expect(run.elapsedMs).toBeLessThan(RUN_TIMEOUT_MS);

        // Every page is presented on the one document rectangle...
        for (const sample of [
            coarse,
            half,
        ]) {
            expect(sample!.frames[0]!.width).toBe(full!.frames[0]!.width);
            expect(sample!.frames[0]!.height).toBe(full!.frames[0]!.height);
        }
        // ...and the half-resolution page is scaled up onto it rather than
        // padded into a corner: both pages carry the same original, so the
        // share of the sheet their content covers has to be the same share.
        // Padding the smaller page would halve it.
        const coverage = [
            full,
            half,
        ].map(sample => ({
            width: sample!.frames[0]!.contentWidth / sample!.frames[0]!.width,
            height: sample!.frames[0]!.contentHeight / sample!.frames[0]!.height,
        }));
        // The half-resolution page's own raster is half the canvas wide, so
        // anything past half the sheet is scale rather than padding. Its
        // cropped box is the detector's answer at its own resolution and is
        // not required to agree with the full page's to the pixel; the written
        // document below is what has to agree absolutely.
        expect(coverage[1]!.width).toBeGreaterThan(0.6);
        expect(coverage[1]!.height).toBeGreaterThan(0.5);
        expect(coverage[0]!.width).toBeGreaterThan(0.6);
        expect(coverage[0]!.height).toBeGreaterThan(0.3);
        expect(Math.max(...sampled.map(sample => sample.settledInMs)))
            .toBeLessThan(PAGE_SETTLE_TIMEOUT_MS);

        // The written document says the same thing absolutely: one page size
        // within a point, one pixel grid, and therefore one output DPI.
        expect(outputPages).toHaveLength(pageCount);
        const first = outputPages[0]!;
        for (const outputPage of outputPages) {
            expect(Math.abs(outputPage.widthPoints - first.widthPoints)).toBeLessThanOrEqual(1);
            expect(Math.abs(outputPage.heightPoints - first.heightPoints)).toBeLessThanOrEqual(1);
            expect(outputPage.images.length).toBeGreaterThan(0);
            for (const image of outputPage.images) {
                expect(image).toEqual(first.images[0]);
                expect(image.widthPx / outputPage.widthPoints)
                    .toBeCloseTo(first.images[0]!.widthPx / first.widthPoints, 3);
            }
        }
        expect(Math.abs(first.widthPoints - CANVAS_WIDTH_POINTS)).toBeLessThanOrEqual(1);
        expect(Math.abs(first.heightPoints - CANVAS_HEIGHT_POINTS)).toBeLessThanOrEqual(1);
        // And that one grid is the finest the document was scanned at, not the
        // coarsest: the 144 DPI pages were resampled up to the 288 DPI page's
        // resolution rather than the document being written at theirs.
        expect(first.images[0]!.widthPx / first.widthPoints * 72)
            .toBeGreaterThan(SOURCE_HIGH_DPI * 0.9);
        expect(viewer.preparing).toBe(false);
        expect(viewer.renderedCanvases).toBeGreaterThan(0);
        expect(logFailures).toEqual([]);
    }, 1_800_000);

    it('cuts a spread onto the half sheet the preview and the output both carry', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const pageCount = 4;
        const sourcePath = await createSpreadScannedFixturePdf(
            'scan-cleanup-matched-canvas-spread.pdf',
            pageCount,
        );
        await openScanCleanup(page, sourcePath);
        await ensureChecked(page, 'Match page size');
        await waitForFunctionInPage(page, () => document.querySelector(
            '.scan-cleanup-toolbar-cancel-detection',
        ) === null, {timeout: 900_000});
        await waitForPreview(page, 1);
        const previewFrames = await readFrames(page);

        await page.click('.scan-cleanup-toolbar-primary-action');
        const run = await waitForCleanedOutput(page, sourcePath, RUN_TIMEOUT_MS);
        await waitForPdfLoaded(page, 180_000);
        await waitForViewerInteractive(page, 180_000);
        const viewer = await readViewerState(page);
        const output = await PDFDocument.load(readFileSync(run.outputPath));
        const outputPages = outputPageRasters(output);
        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-spread.json', {
            pageCount,
            previewFrames,
            outputPages,
            viewer,
            runElapsedMs: run.elapsedMs,
            runSamples: run.samples,
            logFailures,
        });

        // The sheet was cut, so the preview presents two pages...
        expect(previewFrames).toHaveLength(2);
        // ...both on one rectangle, which is the *page* the reader ends up
        // holding rather than the sheet it was scanned on.
        expect(previewFrames[1]!.width).toBe(previewFrames[0]!.width);
        expect(previewFrames[1]!.height).toBe(previewFrames[0]!.height);
        expect(Math.abs(previewFrames[0]!.width / previewFrames[0]!.renderDpi * 72 - SOURCE_PAGE_WIDTH_POINTS))
            .toBeLessThanOrEqual(2);
        // And each half's ink covers a page's worth of the sheet it was
        // normalized onto: this fixture's text spans a little over half its
        // page, so a half padded onto the source sheet — twice as wide — would
        // cover under a third of the frame. Both halves carry the same
        // page-relative ink, so they also have to agree with each other.
        for (const frame of previewFrames) {
            expect(frame.contentWidth / frame.width).toBeGreaterThan(0.5);
        }
        expect(Math.abs(previewFrames[0]!.contentWidth - previewFrames[1]!.contentWidth))
            .toBeLessThanOrEqual(previewFrames[0]!.width * 0.05);

        // Every produced page is that same half sheet, in absolute points.
        expect(outputPages).toHaveLength(pageCount * 2);
        const first = outputPages[0]!;
        expect(first.images.length).toBeGreaterThan(0);
        for (const outputPage of outputPages) {
            expect(Math.abs(outputPage.widthPoints - first.widthPoints)).toBeLessThanOrEqual(1);
            expect(Math.abs(outputPage.heightPoints - first.heightPoints)).toBeLessThanOrEqual(1);
            // One grid for the document: every page embeds the same raster
            // dimensions, whichever layers the engine chose to publish.
            expect(outputPage.images).toEqual(first.images);
        }
        expect(Math.abs(first.widthPoints - SOURCE_PAGE_WIDTH_POINTS)).toBeLessThanOrEqual(2);
        expect(Math.abs(first.heightPoints - SOURCE_PAGE_HEIGHT_POINTS)).toBeLessThanOrEqual(2);
        // The page the preview presented, to within a point.
        expect(Math.abs(previewFrames[0]!.width / previewFrames[0]!.renderDpi * 72 - first.widthPoints))
            .toBeLessThanOrEqual(1);
        expect(Math.abs(previewFrames[0]!.height / previewFrames[0]!.renderDpi * 72 - first.heightPoints))
            .toBeLessThanOrEqual(1);
        expect(viewer.preparing).toBe(false);
        expect(viewer.renderedCanvases).toBeGreaterThan(0);
        expect(logFailures).toEqual([]);
    }, 1_800_000);

    it('cleans one page onto the canvas the whole document is measured on', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const pageCount = 6;
        // Page 1 is the 288 DPI scan and page 2 is the same Letter paper at
        // 144, so a run scoped to page 2 alone would measure a grid at half the
        // document's resolution while agreeing about its rectangle.
        const sourcePath = await createMixedScaleScannedFixturePdf(
            'scan-cleanup-matched-canvas-mixed-scale.pdf',
            pageCount,
        );
        await openScanCleanup(page, sourcePath);
        await ensureChecked(page, 'Match page size');
        await waitForFunctionInPage(page, () => document.querySelector(
            '.scan-cleanup-toolbar-cancel-detection',
        ) === null, {timeout: 900_000});
        // Turn to the low-resolution page and clean that page alone.
        expect(await nextPage(page)).toBe(true);
        await waitForPreview(page, 2);
        const previewFrames = await readFrames(page);
        expect(await evaluateInPage(page, () => {
            const scope = document.querySelector<HTMLElement>('[data-settings-scope="page"]');
            scope?.click();
            return scope !== null;
        })).toBe(true);
        await waitForFunctionInPage(page, () => (document.querySelector(
            '.scan-cleanup-toolbar-primary-action',
        )?.textContent ?? '').includes('page'), {timeout: 30_000});

        await page.click('.scan-cleanup-toolbar-primary-action');
        const run = await waitForCleanedOutput(page, sourcePath, RUN_TIMEOUT_MS);
        const output = await PDFDocument.load(readFileSync(run.outputPath));
        const outputPages = outputPageRasters(output);
        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-partial-run.json', {
            pageCount,
            previewFrames,
            outputPages,
            runElapsedMs: run.elapsedMs,
            logFailures,
        });

        // One page out, and it is the document's page size — a page cleaned on
        // its own has to belong beside the pages a full run produces.
        expect(outputPages).toHaveLength(1);
        expect(Math.abs(outputPages[0]!.widthPoints - CANVAS_WIDTH_POINTS)).toBeLessThanOrEqual(1);
        expect(Math.abs(outputPages[0]!.heightPoints - CANVAS_HEIGHT_POINTS)).toBeLessThanOrEqual(1);
        // Which is the rectangle its preview presented.
        expect(Math.abs(
            previewFrames[0]!.width / previewFrames[0]!.renderDpi * 72
            - outputPages[0]!.widthPoints,
        ))
            .toBeLessThanOrEqual(1);
        // And the same pixel grid, which is the harder half of the promise:
        // this page was scanned at half the document's resolution, so a run
        // that sized its grid from its own scope would write it at 144 DPI and
        // leave a page that cannot sit beside a full run's.
        expect(outputPages[0]!.images.length).toBeGreaterThan(0);
        for (const image of outputPages[0]!.images) {
            expect(image.widthPx / outputPages[0]!.widthPoints * 72)
                .toBeGreaterThan(SOURCE_HIGH_DPI * 0.9);
        }
        expect(logFailures).toEqual([]);
    }, 1_800_000);

    it('keeps the source document readable when a cleanup run is canceled', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const sourceCount = 48;
        const sourcePath = await createVariedContentScannedFixturePdf(
            'scan-cleanup-matched-canvas-canceled.pdf',
            sourceCount,
        );
        await openScanCleanup(page, sourcePath);
        await ensureChecked(page, 'Match page size');
        await waitForPreview(page, 1);

        // The primary action becomes the cancel affordance while the run is
        // working, so the run is started and then abandoned mid-flight. The
        // cancel is clicked from inside the page the moment the affordance
        // appears: a round trip back to the test first is long enough for a
        // small document to finish, which would leave nothing to cancel.
        await page.click('.scan-cleanup-toolbar-primary-action');
        await waitForFunctionInPage(page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!(action?.textContent ?? '').includes('Cancel')) {
                return false;
            }
            action?.click();
            return true;
        }, {timeout: 300_000});
        await waitForFunctionInPage(page, () => !(document.querySelector(
            '.scan-cleanup-toolbar-primary-action',
        )?.textContent ?? '').includes('Cancel'), {timeout: 300_000});
        // The run was abandoned, not finished: the workspace is still the
        // source document rather than a generated one.
        expect((await readRunState(page)).originalPath).toBe(sourcePath);

        // The source is still the open document and its preview still renders.
        await waitForPreview(page, 1);
        const frames = await readFrames(page);
        const previewPage = await readPageNumber(page);
        const canceledState = await readRunState(page);
        // The source file itself is still readable: a canceled run cleans up
        // its own artifacts and leaves the document it read alone.
        const sourceBytes = readFileSync(sourcePath).byteLength;
        const sourcePages = (await PDFDocument.load(readFileSync(sourcePath))).getPageCount();

        // Cancel is recoverable, not terminal: running again produces the
        // document the first attempt abandoned.
        await page.click('.scan-cleanup-toolbar-primary-action');
        const retry = await waitForCleanedOutput(page, sourcePath, RUN_TIMEOUT_MS);
        await waitForPdfLoaded(page, 180_000);
        await waitForViewerInteractive(page, 180_000);
        const viewer = await readViewerState(page);
        const retryPages = outputPageRasters(await PDFDocument.load(readFileSync(retry.outputPath)));

        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-canceled.json', {
            frames,
            previewPage,
            canceledState,
            sourceBytes,
            sourcePages,
            retryElapsedMs: retry.elapsedMs,
            retryPageCount: retryPages.length,
            retrySizes: retryPages.map(({
                widthPoints,
                heightPoints,
            }) => ({
                widthPoints,
                heightPoints,
            })),
            viewer,
            logFailures,
        });

        // The abandoned run left the source workspace intact: its preview still
        // renders the page it was showing, on the canvas it was showing it on,
        // and it reported no error to recover from.
        expect(previewPage).toBe(1);
        expect(frames).toHaveLength(1);
        expect(Math.abs(
            frames[0]!.width / frames[0]!.renderDpi * 72 - CANVAS_WIDTH_POINTS,
        )).toBeLessThanOrEqual(1);
        expect(Math.abs(
            frames[0]!.height / frames[0]!.renderDpi * 72 - CANVAS_HEIGHT_POINTS,
        )).toBeLessThanOrEqual(1);
        expect(canceledState.error).toBe('');
        expect(sourceBytes).toBeGreaterThan(0);
        expect(sourcePages).toBe(sourceCount);
        // The retry produced the whole document, on one rectangle, and left the
        // viewer showing it rather than a blank surface.
        expect(retryPages).toHaveLength(sourceCount);
        expect(new Set(retryPages.map(outputPage => `${String(outputPage.widthPoints)}x${String(outputPage.heightPoints)}`)).size).toBe(1);
        expect(viewer.preparing).toBe(false);
        expect(viewer.renderedCanvases).toBeGreaterThan(0);
        expect(logFailures).toEqual([]);
    }, 1_800_000);

    it('keeps the renderer answering and the progress moving while a larger scan is cleaned', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const pageCount = 60;
        const sourcePath = await createVariedContentScannedFixturePdf(
            'scan-cleanup-matched-canvas-responsive.pdf',
            pageCount,
        );
        await openScanCleanup(page, sourcePath);
        await ensureChecked(page, 'Match page size');
        await waitForPreview(page, 1);

        await startRendererHeartbeat(page);
        await page.click('.scan-cleanup-toolbar-primary-action');
        const run = await waitForCleanedOutput(page, sourcePath, RUN_TIMEOUT_MS);
        const worstRendererStallMs = await stopRendererHeartbeat(page);
        await waitForPdfLoaded(page, 180_000);
        await waitForViewerInteractive(page, 180_000);
        const viewer = await readViewerState(page);
        const outputPages = outputPageRasters(await PDFDocument.load(readFileSync(run.outputPath)));

        const worstLatencyMs = Math.max(...run.samples.map(sample => sample.latencyMs));
        const phases = [...new Set(run.samples.map(sample => sample.phase).filter(phase => phase !== ''))];
        const logFailures = scanCleanupLogFailures(session.name);
        writeEvidence('u53-matched-canvas-responsive.json', {
            pageCount,
            runElapsedMs: run.elapsedMs,
            worstLatencyMs,
            worstRendererStallMs,
            phases,
            sampleCount: run.samples.length,
            samples: run.samples,
            outputSizes: [...new Set(outputPages.map(outputPage => `${String(outputPage.widthPoints)}x${String(outputPage.heightPoints)}`))],
            outputRasterSizes: [...new Set(outputPages.map(outputPage => JSON.stringify(outputPage.images)))],
            viewer,
            logFailures,
        });

        // Measure the event loop inside the renderer. CDP round trips also
        // include runner scheduling and transport latency, which can exceed
        // this budget while the application itself remains responsive.
        expect(run.samples.length).toBeGreaterThan(2);
        expect(worstRendererStallMs).toBeLessThan(RENDERER_LATENCY_BUDGET_MS);
        // And it reported progress rather than a frozen meter.
        expect(phases.length).toBeGreaterThan(0);
        expect(run.elapsedMs).toBeLessThan(RUN_TIMEOUT_MS);
        // The document it produced is still one rectangle on one grid.
        expect(outputPages).toHaveLength(pageCount);
        expect(new Set(outputPages.map(outputPage => JSON.stringify(outputPage))).size).toBe(1);
        expect(viewer.preparing).toBe(false);
        expect(viewer.renderedCanvases).toBeGreaterThan(0);
        expect(logFailures).toEqual([]);
    }, 1_800_000);
});
