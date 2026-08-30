import {execFile} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import {promisify} from 'node:util';
import puppeteer, {type Page} from 'puppeteer-core';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {runElectronE2ETeardown} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    createXlargeDocumentRssSampler,
    type IRendererRssTelemetry,
    type IRssSampler,
} from '@tests/e2e/electron/helpers/xlargeDocumentTelemetry';
import {
    goToPageViaToolbar,
    openDocumentSidebarTab,
    saveViaVisibleToolbarWithDeadline,
    scrollViewerToPage,
    triggerOpenPathInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
    waitForSaveFrontierReady,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const execFileAsync = promisify(execFile);
const PAGE_COUNT = 138_000;
const OUTLINE_COUNT = 10_001;
const FIRST_PAGE = 1;
const MIDDLE_PAGE = 69_001;
const LAST_PAGE = PAGE_COUNT;
const TARGET_PAGES = [
    FIRST_PAGE,
    MIDDLE_PAGE,
    LAST_PAGE,
] as const;
const TARGET_OUTLINE_TITLES = [
    'Scale Outline 00000',
    'Scale Outline 05000',
    'Scale Outline 10000',
] as const;
const RENAMED_FIRST_OUTLINE = 'Scale Outline 00000 saved by Electron';
const FIXTURE_BYTES = 513 * 1024 * 1024;
const TEST_TIMEOUT_MS = 45 * 60 * 1_000;
const STEP_TIMEOUT_MS = 10 * 60 * 1_000;
const RENDERER_JS_HEAP_MAX_DELTA_BYTES = 512 * 1024 * 1_024;
const RENDERER_RSS_MAX_DELTA_BYTES = 1_024 * 1_024 * 1_024;
const RENDERER_COLLECTION_MAX_ITEMS = 512;
const THUMBNAIL_SCROLL_MAX_HEIGHT = 8_388_608;
const ARTIFACT_PATH = resolve(
    '.devkit',
    'test',
    'electron-e2e-artifacts',
    'issue-132-xlarge-viewer-scale-acceptance.json',
);

interface IQpdfOutlineEntry {
    destpageposfrom1?: number;
    kids?: IQpdfOutlineEntry[];
    title?: string;
}

interface IQpdfOutlineEvidence {
    count: number;
    first: Pick<IQpdfOutlineEntry, 'destpageposfrom1' | 'title'> | null;
    middle: Pick<IQpdfOutlineEntry, 'destpageposfrom1' | 'title'> | null;
    last: Pick<IQpdfOutlineEntry, 'destpageposfrom1' | 'title'> | null;
}

interface IRouteEvidence {
    route: 'navigation' | 'outline' | 'preview' | 'thumbnail';
    page: number;
    mountedPageCount: number;
    observedAtEpochMs: number;
    scrollHeight: number | null;
    scrollSegment: number | null;
}

interface IScaleAcceptanceTelemetry {
    fixture: {
        bytes: number;
        outlineCount: number;
        pageCount: number;
    };
    memory: IRendererRssTelemetry | null;
    nativeSave: {
        barrierFinished: boolean;
        nativeProjectionEngaged: boolean;
        receiptVersion: number | null;
    } | null;
    qpdfBeforeSave: IQpdfOutlineEvidence | null;
    qpdfAfterHardClose: IQpdfOutlineEvidence | null;
    reopenedOutline: {
        count: number;
        firstTitle: string | null;
        lastTitle: string | null;
    } | null;
    routes: IRouteEvidence[];
}

interface ISaveReceiptProbeWindow extends Window {
    __issue132SaveReceiptProbe?: {
        barrierFinished: boolean;
        nativeProjectionEngaged: boolean;
        stagedArtifact: ITypedStagedArtifact | null;
    };
    __stagedPdfNativeMutationCommitBarrierForAutomation?: (
        stagedArtifact: ITypedStagedArtifact,
    ) => Promise<void> | void;
}

interface IPreviewReachabilityProbeWindow extends Window { __issue132PreviewReachability?: IRouteEvidence[]; }

function createTelemetry(): IScaleAcceptanceTelemetry {
    return {
        fixture: {
            bytes: FIXTURE_BYTES,
            outlineCount: OUTLINE_COUNT,
            pageCount: PAGE_COUNT,
        },
        memory: null,
        nativeSave: null,
        qpdfBeforeSave: null,
        qpdfAfterHardClose: null,
        reopenedOutline: null,
        routes: [],
    };
}

async function generateFixture(outputPath: string) {
    await execFileAsync(process.execPath, [
        resolve('scripts/generate-xlarge-viewer-acceptance-fixture.mjs'),
        `--output=${outputPath}`,
        `--pages=${String(PAGE_COUNT)}`,
        `--outlines=${String(OUTLINE_COUNT)}`,
        `--bytes=${String(FIXTURE_BYTES)}`,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
    });
}

async function readQpdfOutlineEvidence(pdfPath: string): Promise<IQpdfOutlineEvidence> {
    await execFileAsync('qpdf', [
        '--check',
        pdfPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
    });
    const {stdout: pageCountText} = await execFileAsync('qpdf', [
        '--show-npages',
        pdfPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
    });
    expect(Number(pageCountText.trim())).toBe(PAGE_COUNT);
    const {stdout} = await execFileAsync('qpdf', [
        '--json',
        '--json-key=outlines',
        pdfPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: STEP_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout) as {outlines?: IQpdfOutlineEntry[]};
    const outlines = parsed.outlines ?? [];
    const project = (entry: IQpdfOutlineEntry | undefined) => entry
        ? {
            destpageposfrom1: entry.destpageposfrom1,
            title: entry.title,
        }
        : null;
    return {
        count: outlines.length,
        first: project(outlines[0]),
        middle: project(outlines[Math.floor(outlines.length / 2)]),
        last: project(outlines.at(-1)),
    };
}

function assertQpdfOutlineEvidence(
    evidence: IQpdfOutlineEvidence,
    expectedFirstTitle: string,
) {
    expect(evidence).toEqual({
        count: OUTLINE_COUNT,
        first: {
            destpageposfrom1: FIRST_PAGE,
            title: expectedFirstTitle,
        },
        middle: {
            destpageposfrom1: MIDDLE_PAGE,
            title: TARGET_OUTLINE_TITLES[1],
        },
        last: {
            destpageposfrom1: LAST_PAGE,
            title: TARGET_OUTLINE_TITLES[2],
        },
    });
}

async function readRouteEvidence(
    page: Page,
    route: IRouteEvidence['route'],
    pageNumber: number,
): Promise<IRouteEvidence> {
    const state = await page.evaluate((routeName: IRouteEvidence['route']) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        const pdfViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const thumbnails = host?.querySelector<HTMLElement>('.pdf-thumbnails') ?? null;
        const wrapper = thumbnails?.querySelector<HTMLElement>('.pdf-thumbnails-virtual-wrapper') ?? null;
        const openingViewport = host?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
        const pageSourceSelector = '[data-testid="document-page-source-page"], [data-document-page-number]';
        const routeRoot = routeName === 'preview' ? openingViewport : routeName === 'thumbnail' ? thumbnails : pdfViewer;
        return {
            bookmarkRows: host?.querySelectorAll('.document-bookmark-item__row, .pdf-bookmark-item-row').length ?? 0,
            mountedPageCount: routeName === 'preview'
                ? host?.querySelectorAll(pageSourceSelector).length ?? 0
                : routeName === 'thumbnail'
                    ? thumbnails?.querySelectorAll('.pdf-thumbnail[data-page]').length ?? 0
                    : pdfViewer?.querySelectorAll('.page_container[data-page]').length ?? 0,
            pageContainers: pdfViewer?.querySelectorAll('.page_container[data-page]').length ?? 0,
            pageSourcePages: host?.querySelectorAll(pageSourceSelector).length ?? 0,
            scrollHeight: routeRoot?.scrollHeight ?? null,
            scrollSegment: wrapper ? Number(wrapper.dataset.thumbnailScrollSegment ?? 0) : null,
            thumbnailRows: thumbnails?.querySelectorAll('.pdf-thumbnail[data-page]').length ?? 0,
        };
    }, route);
    expect(state.mountedPageCount, JSON.stringify(state)).toBeGreaterThan(0);
    expect(state.mountedPageCount, JSON.stringify(state)).toBeLessThanOrEqual(RENDERER_COLLECTION_MAX_ITEMS);
    expect(state.pageContainers, JSON.stringify(state)).toBeLessThanOrEqual(RENDERER_COLLECTION_MAX_ITEMS);
    expect(state.pageSourcePages, JSON.stringify(state)).toBeLessThanOrEqual(RENDERER_COLLECTION_MAX_ITEMS);
    expect(state.thumbnailRows, JSON.stringify(state)).toBeLessThanOrEqual(RENDERER_COLLECTION_MAX_ITEMS);
    expect(state.bookmarkRows, JSON.stringify(state)).toBeLessThanOrEqual(RENDERER_COLLECTION_MAX_ITEMS);
    if (route === 'thumbnail') {
        expect(state.scrollHeight, JSON.stringify(state)).not.toBeNull();
        expect(state.scrollHeight!, JSON.stringify(state)).toBeLessThanOrEqual(THUMBNAIL_SCROLL_MAX_HEIGHT);
    }
    return {
        route,
        page: pageNumber,
        mountedPageCount: state.mountedPageCount,
        observedAtEpochMs: Date.now(),
        scrollHeight: state.scrollHeight,
        scrollSegment: state.scrollSegment,
    };
}

async function installPreviewReachabilityProbe(page: Page) {
    await page.evaluate(() => {
        const probeWindow = window as IPreviewReachabilityProbeWindow;
        probeWindow.__issue132PreviewReachability = [];
        const capture = () => {
            const image = document.querySelector<HTMLImageElement>(
                '.editor-pane.is-active [data-testid="document-opening-native-preview"]',
            );
            const shell = image?.closest<HTMLElement>('[data-document-page-number]') ?? null;
            const pageNumber = Number(shell?.dataset.documentPageNumber ?? 0);
            if (!image?.complete || image.naturalWidth <= 0 || pageNumber <= 0) {
                return;
            }
            const evidence = probeWindow.__issue132PreviewReachability!;
            if (evidence.some(entry => entry.page === pageNumber)) {
                return;
            }
            const host = image.closest<HTMLElement>('.workspace-host');
            const openingViewport = host?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            evidence.push({
                route: 'preview',
                page: pageNumber,
                mountedPageCount: host?.querySelectorAll(
                    '[data-testid="document-page-source-page"], [data-document-page-number]',
                ).length ?? 0,
                observedAtEpochMs: Date.now(),
                scrollHeight: openingViewport?.scrollHeight ?? null,
                scrollSegment: null,
            });
        };
        document.addEventListener('load', capture, true);
        capture();
    });
}

async function pollFreshPageUntil<T>(
    page: Page,
    label: string,
    probe: (probePage: Page) => Promise<T | null>,
): Promise<T> {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
        const browser = await puppeteer.connect({
            browserWSEndpoint: page.browser().wsEndpoint(),
            defaultViewport: null,
            protocolTimeout: 15_000,
        });
        try {
            const probePage = (await browser.pages()).find(candidate => candidate.url() === page.url());
            if (!probePage) {
                throw new Error(`Electron page target ${page.url()} was unavailable`);
            }
            const result = await probe(probePage);
            if (result !== null) {
                return result;
            }
            lastError = null;
        } catch (error) {
            lastError = error;
        } finally {
            await browser.disconnect();
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000));
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Timed out waiting for ${label}${detail}`);
}

async function waitForOpeningPreviewPage(page: Page, pageNumber: number): Promise<IRouteEvidence> {
    const evidence = await pollFreshPageUntil(
        page,
        `native preview page ${String(pageNumber)}`,
        probePage => probePage.evaluate((targetPage: number) => {
            const records = (window as IPreviewReachabilityProbeWindow)
                .__issue132PreviewReachability ?? [];
            return records.find(entry => entry.page === targetPage) ?? null;
        }, pageNumber),
    );
    expect(evidence.mountedPageCount).toBeGreaterThan(0);
    expect(evidence.mountedPageCount).toBeLessThanOrEqual(RENDERER_COLLECTION_MAX_ITEMS);
    return evidence;
}

async function proveNativePreviewReachability(
    page: Page,
    pdfPath: string,
    telemetry: IScaleAcceptanceTelemetry,
) {
    await installPreviewReachabilityProbe(page);
    const openPromise = triggerOpenPathInApp(page, pdfPath, STEP_TIMEOUT_MS);
    for (const pageNumber of TARGET_PAGES) {
        if (pageNumber !== FIRST_PAGE) {
            const navigation = await callWorkspaceCommand(page, 'handleGoToPage', [pageNumber]);
            expect(navigation.called).toBe(true);
            await waitForWorkspaceToolbarSnapshot(page, {
                currentPage: pageNumber,
                minTotalPages: PAGE_COUNT,
            }, {timeoutMs: STEP_TIMEOUT_MS});
        }
        telemetry.routes.push(await waitForOpeningPreviewPage(page, pageNumber));
    }
    await openPromise;
    await waitForPdfLoaded(page, STEP_TIMEOUT_MS);
    await waitForViewerInteractive(page, STEP_TIMEOUT_MS);
}

async function waitForRenderedPage(page: Page, pageNumber: number) {
    await scrollViewerToPage(page, pageNumber);
    await pollFreshPageUntil(
        page,
        `rendered viewer page ${String(pageNumber)}`,
        probePage => probePage.evaluate((targetPage: number) => {
            const pageElement = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .page_container[data-page="${String(targetPage)}"]`,
            );
            const canvas = pageElement?.querySelector<HTMLCanvasElement>(
                '.page_canvas__render-layer canvas, .page_canvas canvas, canvas',
            ) ?? null;
            const viewer = pageElement?.closest<HTMLElement>('.pdfViewer') ?? null;
            if (!pageElement || !canvas || !viewer || canvas.width <= 0 || canvas.height <= 0) {
                return null;
            }
            const pageRect = pageElement.getBoundingClientRect();
            const viewerRect = viewer.getBoundingClientRect();
            return pageElement.classList.contains('page_container--rendered')
                && Math.min(pageRect.bottom, viewerRect.bottom) - Math.max(pageRect.top, viewerRect.top) > 8
                ? true
                : null;
        }, pageNumber),
    );
}

async function proveToolbarNavigationReachability(
    page: Page,
    telemetry: IScaleAcceptanceTelemetry,
) {
    for (const pageNumber of TARGET_PAGES) {
        await goToPageViaToolbar(page, pageNumber, STEP_TIMEOUT_MS);
        await waitForRenderedPage(page, pageNumber);
        telemetry.routes.push(await readRouteEvidence(page, 'navigation', pageNumber));
    }
}

function thumbnailNeighbor(pageNumber: number) {
    return pageNumber === LAST_PAGE ? pageNumber - 1 : pageNumber + 1;
}

async function proveThumbnailReachability(
    page: Page,
    telemetry: IScaleAcceptanceTelemetry,
) {
    for (const pageNumber of TARGET_PAGES) {
        await goToPageViaToolbar(page, thumbnailNeighbor(pageNumber), STEP_TIMEOUT_MS);
        await openDocumentSidebarTab(page, 'Pages', STEP_TIMEOUT_MS);
        await pollFreshPageUntil(
            page,
            `rendered thumbnail page ${String(pageNumber)}`,
            probePage => probePage.evaluate((targetPage: number) => {
                const thumbnail = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active .pdf-thumbnail[data-page="${String(targetPage)}"]`,
                );
                const canvas = thumbnail?.querySelector<HTMLCanvasElement>('.pdf-thumbnail-canvas') ?? null;
                return thumbnail
                    && canvas
                    && canvas.dataset.thumbnailRendered === 'true'
                    && canvas.width > 0
                    && canvas.height > 0
                    ? true
                    : null;
            }, pageNumber),
        );
        await page.click(`.editor-pane.is-active .pdf-thumbnail[data-page="${String(pageNumber)}"]`);
        await waitForWorkspaceToolbarSnapshot(page, {currentPage: pageNumber}, {timeoutMs: STEP_TIMEOUT_MS});
        await waitForRenderedPage(page, pageNumber);
        telemetry.routes.push(await readRouteEvidence(page, 'thumbnail', pageNumber));
    }
}

async function waitForOutlineTitle(page: Page, title: string) {
    await pollFreshPageUntil(
        page,
        `outline title ${title}`,
        probePage => probePage.evaluate((expectedTitle: string) => Array.from(
            document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .document-bookmark-item__title',
            ),
        ).some(element => element.textContent?.trim() === expectedTitle) ? true : null, title),
    );
}

async function clickOutlineTitle(page: Page, title: string) {
    const clicked = await page.evaluate((expectedTitle: string) => {
        const titleElement = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .document-bookmark-item__title',
        )).find(element => element.textContent?.trim() === expectedTitle);
        titleElement?.closest<HTMLElement>('.document-bookmark-item__row')?.click();
        return titleElement !== undefined;
    }, title);
    expect(clicked).toBe(true);
}

async function proveOutlineReachability(
    page: Page,
    telemetry: IScaleAcceptanceTelemetry,
) {
    for (const [
        index,
        pageNumber,
    ] of TARGET_PAGES.entries()) {
        const title = TARGET_OUTLINE_TITLES[index]!;
        await goToPageViaToolbar(page, pageNumber, STEP_TIMEOUT_MS);
        await openDocumentSidebarTab(page, 'Bookmarks', STEP_TIMEOUT_MS);
        await waitForOutlineTitle(page, title);
        await goToPageViaToolbar(page, thumbnailNeighbor(pageNumber), STEP_TIMEOUT_MS);
        await clickOutlineTitle(page, title);
        await waitForWorkspaceToolbarSnapshot(page, {currentPage: pageNumber}, {timeoutMs: STEP_TIMEOUT_MS});
        await waitForRenderedPage(page, pageNumber);
        telemetry.routes.push(await readRouteEvidence(page, 'outline', pageNumber));
    }
}

async function renameFirstOutlineForNativeSave(page: Page) {
    await goToPageViaToolbar(page, FIRST_PAGE, STEP_TIMEOUT_MS);
    await openDocumentSidebarTab(page, 'Bookmarks', STEP_TIMEOUT_MS);
    await waitForOutlineTitle(page, TARGET_OUTLINE_TITLES[0]);
    await page.click('.editor-pane.is-active button[aria-label="Enter bookmark edit mode"]');
    await page.waitForSelector('.editor-pane.is-active .pdf-bookmark-item-row', {timeout: STEP_TIMEOUT_MS});
    await page.click('.editor-pane.is-active .pdf-bookmark-item-actions-trigger');
    await page.waitForSelector('.bookmarks-context-menu .pdf-context-menu__action', {timeout: STEP_TIMEOUT_MS});
    await page.click('.bookmarks-context-menu .pdf-context-menu__action');
    const inputSelector = '.editor-pane.is-active .pdf-bookmark-item-input';
    await page.waitForSelector(inputSelector, {timeout: STEP_TIMEOUT_MS});
    await page.click(inputSelector, {count: 3});
    await page.keyboard.type(RENAMED_FIRST_OUTLINE);
    await page.keyboard.press('Enter');
    await page.waitForFunction((expectedTitle: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-bookmark-item-title'),
    ).some(element => element.textContent?.trim() === expectedTitle), {timeout: STEP_TIMEOUT_MS}, RENAMED_FIRST_OUTLINE);
    await waitForSaveFrontierReady(page, STEP_TIMEOUT_MS);
    const dirty = await readWorkspaceStateValues<{dirtyState?: {bookmarksDirty?: boolean};}>(
        page,
        ['dirtyState'],
    );
    expect(dirty.dirtyState?.bookmarksDirty).toBe(true);
}

async function installSaveReceiptProbe(page: Page) {
    await page.evaluate(() => {
        const probeWindow = window as ISaveReceiptProbeWindow;
        const probe = {
            barrierFinished: false,
            nativeProjectionEngaged: false,
            stagedArtifact: null,
        };
        probeWindow.__issue132SaveReceiptProbe = probe;
        probeWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = async (stagedArtifact) => {
            probe.nativeProjectionEngaged = true;
            probe.stagedArtifact = stagedArtifact;
            probe.barrierFinished = true;
        };
    });
}

async function readReopenedOutlineState(page: Page) {
    await openDocumentSidebarTab(page, 'Bookmarks', STEP_TIMEOUT_MS);
    await waitForOutlineTitle(page, RENAMED_FIRST_OUTLINE);
    await goToPageViaToolbar(page, LAST_PAGE, STEP_TIMEOUT_MS);
    await waitForOutlineTitle(page, TARGET_OUTLINE_TITLES[2]);
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .document-bookmark-item__title',
        ));
        return {
            firstTitle: RENAMED_FIRST_OUTLINE,
            lastTitle: rows.find(element => element.textContent?.trim() === TARGET_OUTLINE_TITLES[2])
                ?.textContent?.trim() ?? null,
        };
    });
}

describe('Electron E2E - 138,000-page viewer scale acceptance', () => {
    it('keeps preview, layout, thumbnails, and outlines reachable and saves every outline natively', async () => {
        const telemetry = createTelemetry();
        await mkdir(resolve('.devkit', 'tmp'), {recursive: true});
        const tempRoot = await mkdtemp(resolve('.devkit', 'tmp', 'issue-132-scale-'));
        const fixturePath = join(tempRoot, '138000-pages-10001-outlines.pdf');
        let session: IElectronE2ESession | null = null;
        let sampler: IRssSampler | null = null;
        let savedPath: string | null = null;
        let bodyFailure: unknown = null;

        try {
            await generateFixture(fixturePath);
            telemetry.qpdfBeforeSave = await readQpdfOutlineEvidence(fixturePath);
            assertQpdfOutlineEvidence(telemetry.qpdfBeforeSave, TARGET_OUTLINE_TITLES[0]);

            session = await startElectronE2ESession(`e2e-issue-132-scale-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            });
            sampler = createXlargeDocumentRssSampler(
                session.page,
                getSessionInfo(session.name)?.electronPid ?? null,
            );
            await proveNativePreviewReachability(session.page, fixturePath, telemetry);
            await proveToolbarNavigationReachability(session.page, telemetry);
            await proveThumbnailReachability(session.page, telemetry);
            await proveOutlineReachability(session.page, telemetry);
            await renameFirstOutlineForNativeSave(session.page);
            await installSaveReceiptProbe(session.page);

            const sourceState = await readWorkspaceStateValues<{
                originalPath?: string | null;
                workingCopyPath?: string | null;
            }>(session.page, [
                'originalPath',
                'workingCopyPath',
            ]);
            const saveEventPath = sourceState.originalPath ?? fixturePath;
            await saveViaVisibleToolbarWithDeadline(
                session.page,
                STEP_TIMEOUT_MS,
                saveEventPath,
                {
                    label: 'issue #132 10,001-outline native save',
                    onTimeout: () => session!.stop(),
                },
            );
            await waitForViewerInteractive(session.page, STEP_TIMEOUT_MS);
            const receipt = await session.page.evaluate(() => (
                (window as ISaveReceiptProbeWindow).__issue132SaveReceiptProbe ?? null
            ));
            expect(receipt?.nativeProjectionEngaged).toBe(true);
            expect(receipt?.barrierFinished).toBe(true);
            expect(receipt?.stagedArtifact).toMatchObject({
                artifactKind: 'pdf',
                receiptVersion: 2,
            });
            telemetry.nativeSave = {
                barrierFinished: receipt?.barrierFinished ?? false,
                nativeProjectionEngaged: receipt?.nativeProjectionEngaged ?? false,
                receiptVersion: receipt?.stagedArtifact?.receiptVersion ?? null,
            };
            const savedState = await readWorkspaceStateValues<{
                pdfSourceState?: {reloadPath?: string | null};
                workingCopyPath?: string | null;
            }>(session.page, [
                'pdfSourceState',
                'workingCopyPath',
            ]);
            savedPath = savedState.pdfSourceState?.reloadPath
                ?? savedState.workingCopyPath
                ?? fixturePath;

            telemetry.memory = await sampler.stop();
            sampler = null;
            expect(telemetry.memory.rendererJsHeapDeltaBytes).not.toBeNull();
            expect(telemetry.memory.rendererJsHeapDeltaBytes!).toBeLessThanOrEqual(
                RENDERER_JS_HEAP_MAX_DELTA_BYTES,
            );
            expect(telemetry.memory.rendererRssDeltaBytes).not.toBeNull();
            expect(telemetry.memory.rendererRssDeltaBytes!).toBeLessThanOrEqual(
                RENDERER_RSS_MAX_DELTA_BYTES,
            );

            await session.stop();
            session = null;
            telemetry.qpdfAfterHardClose = await readQpdfOutlineEvidence(savedPath);
            assertQpdfOutlineEvidence(telemetry.qpdfAfterHardClose, RENAMED_FIRST_OUTLINE);

            session = await startElectronE2ESession(`e2e-issue-132-hard-reopen-${Date.now()}`, {
                clean: true,
                extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
                initialOpenPaths: [savedPath],
            });
            await waitForPdfLoaded(session.page, STEP_TIMEOUT_MS);
            await waitForViewerInteractive(session.page, STEP_TIMEOUT_MS);
            telemetry.reopenedOutline = {
                count: telemetry.qpdfAfterHardClose.count,
                ...await readReopenedOutlineState(session.page),
            };
            expect(telemetry.reopenedOutline).toEqual({
                count: OUTLINE_COUNT,
                firstTitle: RENAMED_FIRST_OUTLINE,
                lastTitle: TARGET_OUTLINE_TITLES[2],
            });
        } catch (error) {
            bodyFailure = error;
        }

        await runElectronE2ETeardown(bodyFailure, [
            {
                label: 'memory sampler',
                run: async () => {
                    if (sampler) {
                        telemetry.memory = await sampler.stop();
                        sampler = null;
                    }
                },
            },
            {
                label: 'Electron session',
                run: async () => {
                    await session?.stop();
                    session = null;
                },
            },
            {
                label: 'acceptance telemetry',
                run: async () => {
                    await mkdir(resolve(ARTIFACT_PATH, '..'), {recursive: true});
                    await writeFile(ARTIFACT_PATH, `${JSON.stringify(telemetry, null, 2)}\n`, 'utf8');
                },
            },
            {
                label: 'generated fixture cleanup',
                run: async () => {
                    await rm(tempRoot, {
                        force: true,
                        recursive: true,
                    });
                },
            },
        ]);
    }, TEST_TIMEOUT_MS);
});
