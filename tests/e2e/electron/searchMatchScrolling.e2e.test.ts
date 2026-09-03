import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
import {
    createSearchMatchScrollFixturePdf,
    SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT,
    SEARCH_MATCH_SCROLL_FIXTURE_QUERY,
    SEARCH_MATCH_SCROLL_FIXTURE_TARGET_MATCH,
    SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    ensureSidebarOpen,
    openDocumentSidebarTab,
    openPdfInApp,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {enablePdfDiagnosticSession} from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const SEARCH_MATCH_SCROLL_TIMEOUT_MS = 240_000;
const SEARCH_MATCH_PAINT_TIMEOUT_MS = 30_000;
const defaultSearchMatchScrollResultCount = SEARCH_MATCH_SCROLL_FIXTURE_PAGE_COUNT - 1 + 4;
const suppliedSearchMatchScrollPdf = process.env.EVB_SEARCH_SCROLL_PDF;

function readPositiveIntegerEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return fallback;
    }
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

interface IViewportRect {
    bottom: number;
    left: number;
    right: number;
    top: number;
}

interface IViewportSize {
    height: number;
    width: number;
}

async function countWarmHighlightPixels(
    screenshot: Uint8Array,
    viewportRect: IViewportRect,
    viewportSize: IViewportSize,
) {
    const image = await loadImage(Buffer.from(screenshot));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);

    const scaleX = image.width / viewportSize.width;
    const scaleY = image.height / viewportSize.height;
    const startX = Math.max(0, Math.floor(viewportRect.left * scaleX));
    const endX = Math.min(image.width, Math.ceil(viewportRect.right * scaleX));
    const startY = Math.max(0, Math.floor(viewportRect.top * scaleY));
    const endY = Math.min(image.height, Math.ceil(viewportRect.bottom * scaleY));
    if (endX <= startX || endY <= startY) {
        return 0;
    }

    const pixels = context.getImageData(startX, startY, endX - startX, endY - startY).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        const alpha = pixels[index + 3] ?? 0;
        if (
            alpha > 0
            && red > 175
            && green > 95
            && red - blue > 45
            && green - blue > 20
        ) {
            count += 1;
        }
    }
    return count;
}

function readPositiveNumberEnv(name: string, fallback: number) {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return fallback;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number`);
    }
    return value;
}

const searchMatchScrollConfig = {
    expectedResultCount: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_RESULT_COUNT',
        suppliedSearchMatchScrollPdf ? 25 : defaultSearchMatchScrollResultCount,
    ),
    fixturePath: suppliedSearchMatchScrollPdf,
    query: process.env.EVB_SEARCH_SCROLL_QUERY
        ?? (suppliedSearchMatchScrollPdf ? 'lezgian' : SEARCH_MATCH_SCROLL_FIXTURE_QUERY),
    targetGroup: process.env.EVB_SEARCH_SCROLL_TARGET_GROUP
        ?? String(suppliedSearchMatchScrollPdf ? 23 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE),
    targetMatch: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_TARGET_MATCH',
        suppliedSearchMatchScrollPdf ? 2 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_MATCH,
    ),
    targetViewerPage: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_TARGET_PAGE',
        suppliedSearchMatchScrollPdf ? 23 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
    ),
    zoom: readPositiveNumberEnv(
        'EVB_SEARCH_SCROLL_ZOOM',
        suppliedSearchMatchScrollPdf ? 1.31 : 3.8,
    ),
};

const sessionFixture = createElectronE2ESessionFixture({
    restartBeforeEach: false,
    sessionName: () => `e2e-search-match-scroll-${Date.now()}`,
    timeoutMs: 300_000,
});

describe('Electron E2E - PDF search match scrolling', () => {
    it('centers the clicked duplicate match after a high-zoom xlarge search', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        const fixturePath = searchMatchScrollConfig.fixturePath
            ?? await createSearchMatchScrollFixturePdf(`search-match-scroll-${Date.now()}.pdf`);
        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 900,
            width: 1_440,
        });
        await openPdfInApp(session.page, fixturePath, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
        await enablePdfDiagnosticSession(session.page, {
            navigation: true,
            render: true,
        });
        await ensureSidebarOpen(session.page);
        await openDocumentSidebarTab(session.page, 'Search');

        const searchInput = await session.page.$(
            '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-bar input',
        );
        expect(searchInput).not.toBeNull();
        await searchInput!.type(searchMatchScrollConfig.query);
        const searchStarted = await session.page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .search-run-button',
            );
            if (!button || button.disabled) {
                return false;
            }
            button.click();
            return true;
        });
        expect(searchStarted).toBe(true);

        await waitForFunctionInPage(session.page, (expectedCount: number) => {
            const summary = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-header-summary',
            );
            const spinner = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-spinner',
            );
            return Boolean(
                summary?.textContent?.trim().startsWith(`${expectedCount} results`)
                && !spinner,
            );
        }, {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, searchMatchScrollConfig.expectedResultCount);

        const zoomResult = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [searchMatchScrollConfig.zoom]);
        expect(zoomResult.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(session.page, {
            hasPdf: true,
            minEffectiveZoom: searchMatchScrollConfig.zoom * 0.98,
        }, {timeoutMs: SEARCH_MATCH_SCROLL_TIMEOUT_MS});

        const foundTargetGroup = await session.page.evaluate(async (targetGroup: string) => {
            const list = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-list',
            );
            if (!list) {
                throw new Error('Search results list was not found');
            }
            const findGroup = () => Array.from(list.querySelectorAll<HTMLElement>(
                '.document-search-results-group-toggle',
            )).find(group => group.dataset.pageNumber === targetGroup);
            const waitForVirtualRows = () => new Promise<void>(resolve => requestAnimationFrame(() => (
                requestAnimationFrame(() => resolve())
            )));
            const step = Math.max(36, Math.floor(list.clientHeight * 0.75));
            for (let top = 0; top <= list.scrollHeight; top += step) {
                list.scrollTop = top;
                list.dispatchEvent(new Event('scroll'));
                await waitForVirtualRows();
                const group = findGroup();
                if (group) {
                    group.scrollIntoView({block: 'center'});
                    await waitForVirtualRows();
                    return true;
                }
            }
            list.scrollTop = list.scrollHeight;
            list.dispatchEvent(new Event('scroll'));
            await waitForVirtualRows();
            return Boolean(findGroup());
        }, searchMatchScrollConfig.targetGroup);
        expect(foundTargetGroup).toBe(true);

        const openedTargetGroup = await session.page.evaluate((targetGroup: string) => {
            const group = Array.from(document.querySelectorAll<HTMLButtonElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-group-toggle',
            )).find(candidate => candidate.dataset.pageNumber === targetGroup);
            if (!group) {
                return false;
            }
            if (group.getAttribute('aria-expanded') !== 'true') {
                group.click();
            }
            return true;
        }, searchMatchScrollConfig.targetGroup);
        expect(openedTargetGroup).toBe(true);

        await waitForFunctionInPage(session.page, ({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => Boolean(document.querySelector(
            `.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[data-page-number="${String(targetPage)}"][data-page-match-number="${String(targetMatch)}"]`,
        )), {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });

        await session.page.evaluate(() => {
            const diagnosticWindow = window as Window & {
                __clearPdfNavLog?: () => void;
                __clearPdfRenderTrace?: () => void;
            };
            diagnosticWindow.__clearPdfNavLog?.();
            diagnosticWindow.__clearPdfRenderTrace?.();
        });
        const clickedTarget = await session.page.evaluate(({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => {
            const result = document.querySelector<HTMLElement>(
                `.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[data-page-number="${String(targetPage)}"][data-page-match-number="${String(targetMatch)}"]`,
            );
            result?.click();
            return Boolean(result);
        }, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });
        expect(clickedTarget).toBe(true);

        await waitForFunctionInPage(session.page, ({
            targetMatch,
            targetPage,
        }: {
            targetMatch: number;
            targetPage: number;
        }) => {
            const currentResult = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[aria-current="true"]',
            );
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const highlights = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []).map(highlight => highlight.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            if (currentResult?.dataset.pageNumber !== String(targetPage)
                || currentResult.dataset.pageMatchNumber !== String(targetMatch)
                || !viewer
                || !page
                || highlights.length === 0) {
                return false;
            }
            return true;
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS}, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });

        const readFinalState = () => session.page.evaluate((targetPage: number) => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const viewerRect = viewer?.getBoundingClientRect() ?? null;
            const highlightElements = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []);
            const highlightRects = highlightElements.map(element => element.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            const highlight = highlightRects.length > 0
                ? {
                    bottom: Math.max(...highlightRects.map(rect => rect.bottom)),
                    left: Math.min(...highlightRects.map(rect => rect.left)),
                    right: Math.max(...highlightRects.map(rect => rect.right)),
                    top: Math.min(...highlightRects.map(rect => rect.top)),
                }
                : null;
            const trace = ((window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload?: Record<string, unknown>
            }>;}).__getPdfRenderTrace?.() ?? []);
            const navigationMessages = ((window as Window & {__getPdfNavLog?: () => Array<{message: string;}>;})
                .__getPdfNavLog?.() ?? []).map(entry => entry.message);
            const appliedCount = trace.filter(entry => (
                entry.event === 'navigation-viewport-authority-applied'
                && entry.payload?.kind === 'search'
            )).length;
            return {
                highlight: highlight
                    ? {
                        bottom: highlight.bottom,
                        left: highlight.left,
                        right: highlight.right,
                        top: highlight.top,
                    }
                    : null,
                highlightBackgroundColors: highlightElements.map(element => getComputedStyle(element).backgroundColor),
                highlightOpacities: highlightElements.map(element => getComputedStyle(element).opacity),
                highlightText: highlightElements.map(element => element.textContent ?? '').join(''),
                highlightVisibilities: highlightElements.map(element => getComputedStyle(element).visibility),
                navigationMessages,
                scrollTop: viewer?.scrollTop ?? null,
                appliedCount,
                trace: trace.filter(entry => [
                    'navigation-text-anchor-refined',
                    'navigation-viewport-authority-applied',
                ].includes(entry.event)),
                viewportSize: {
                    height: window.innerHeight,
                    width: window.innerWidth,
                },
                viewer: viewerRect
                    ? {
                        bottom: viewerRect.bottom,
                        left: viewerRect.left,
                        right: viewerRect.right,
                        top: viewerRect.top,
                    }
                    : null,
            };
        }, searchMatchScrollConfig.targetViewerPage);

        let finalState = await readFinalState();
        expect(finalState.highlight).not.toBeNull();
        expect(finalState.viewer).not.toBeNull();
        expect(finalState.highlightText.toLocaleLowerCase()).toContain(
            searchMatchScrollConfig.query.toLocaleLowerCase(),
        );
        expect(finalState.highlightBackgroundColors).not.toContain('rgba(0, 0, 0, 0)');
        expect(finalState.highlightOpacities).not.toContain('0');
        expect(finalState.highlightVisibilities).not.toContain('hidden');

        await waitForFunctionInPage(session.page, () => {
            const trace = ((window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload?: Record<string, unknown>
            }>;}).__getPdfRenderTrace?.() ?? []);
            return trace.filter(entry => (
                entry.event === 'navigation-viewport-authority-applied'
                && entry.payload?.kind === 'search'
            )).length === 1;
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS});

        await waitForFunctionInPage(session.page, (targetPage: number) => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const viewerRect = viewer?.getBoundingClientRect();
            const highlightRects = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []).map(element => element.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            if (!viewerRect || highlightRects.length === 0) {
                return false;
            }
            const highlight = {
                bottom: Math.max(...highlightRects.map(rect => rect.bottom)),
                left: Math.min(...highlightRects.map(rect => rect.left)),
                right: Math.max(...highlightRects.map(rect => rect.right)),
                top: Math.min(...highlightRects.map(rect => rect.top)),
            };
            const centeredY = Math.abs(
                (highlight.top + highlight.bottom) / 2 - (viewerRect.top + viewerRect.bottom) / 2,
            ) < 120;
            return centeredY
                && highlight.left >= viewerRect.left - 2
                && highlight.right <= viewerRect.right + 2
                && highlight.top >= viewerRect.top - 2
                && highlight.bottom <= viewerRect.bottom + 2;
        }, {timeout: SEARCH_MATCH_PAINT_TIMEOUT_MS}, searchMatchScrollConfig.targetViewerPage);

        finalState = await readFinalState();
        expect(finalState.appliedCount).toBe(1);
        expect(finalState.navigationMessages.some(message => message.includes('scrollToCurrentMatch'))).toBe(false);
        expect(finalState.highlight!.left).toBeGreaterThanOrEqual(finalState.viewer!.left - 2);
        expect(finalState.highlight!.right).toBeLessThanOrEqual(finalState.viewer!.right + 2);
        expect(finalState.highlight!.top).toBeGreaterThanOrEqual(finalState.viewer!.top - 2);
        expect(finalState.highlight!.bottom).toBeLessThanOrEqual(finalState.viewer!.bottom + 2);
        const highlightCenterY = (finalState.highlight!.top + finalState.highlight!.bottom) / 2;
        const viewerCenterY = (finalState.viewer!.top + finalState.viewer!.bottom) / 2;
        expect(Math.abs(highlightCenterY - viewerCenterY)).toBeLessThan(120);
        await session.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => (
            requestAnimationFrame(() => resolve())
        ))));
        const screenshot = await session.page.screenshot({type: 'png'});
        expect(await countWarmHighlightPixels(
            screenshot,
            finalState.highlight!,
            finalState.viewportSize,
        )).toBeGreaterThan(4);
    }, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
});
