import {
    describe,
    expect,
    it,
} from 'vitest';
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

const SEARCH_MATCH_SCROLL_TIMEOUT_MS = 120_000;
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

const searchMatchScrollConfig = {
    expectedResultCount: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_RESULT_COUNT',
        suppliedSearchMatchScrollPdf ? 25 : defaultSearchMatchScrollResultCount,
    ),
    fixturePath: suppliedSearchMatchScrollPdf,
    query: process.env.EVB_SEARCH_SCROLL_QUERY
        ?? (suppliedSearchMatchScrollPdf ? 'lezgian' : SEARCH_MATCH_SCROLL_FIXTURE_QUERY),
    targetGroup: process.env.EVB_SEARCH_SCROLL_TARGET_GROUP
        ?? String(SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE),
    targetMatch: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_TARGET_MATCH',
        SEARCH_MATCH_SCROLL_FIXTURE_TARGET_MATCH,
    ),
    targetViewerPage: readPositiveIntegerEnv(
        'EVB_SEARCH_SCROLL_TARGET_PAGE',
        suppliedSearchMatchScrollPdf ? 240 : SEARCH_MATCH_SCROLL_FIXTURE_TARGET_PAGE,
    ),
};

const sessionFixture = createElectronE2ESessionFixture({
    restartBeforeEach: false,
    sessionName: () => `e2e-search-match-scroll-${Date.now()}`,
    timeoutMs: 180_000,
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

        const zoomResult = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [3.8]);
        expect(zoomResult.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(session.page, {
            hasPdf: true,
            minEffectiveZoom: 3.7,
        }, {timeoutMs: SEARCH_MATCH_SCROLL_TIMEOUT_MS});

        await session.page.evaluate(() => {
            const list = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-list',
            );
            if (!list) {
                throw new Error('Search results list was not found');
            }
            list.scrollTop = list.scrollHeight;
            list.dispatchEvent(new Event('scroll'));
        });
        await waitForFunctionInPage(session.page, (targetGroup: string) => Array.from(
            document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-group-toggle',
            ),
        ).some(group => group.dataset.pageNumber === targetGroup), {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, searchMatchScrollConfig.targetGroup);

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

        await session.page.evaluate(() => {
            const list = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-list',
            );
            if (!list) {
                throw new Error('Search results list was not found after opening the target group');
            }
            list.scrollTop = list.scrollHeight;
            list.dispatchEvent(new Event('scroll'));
        });
        await waitForFunctionInPage(session.page, (targetMatch: number) => Array.from(
            document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result',
            ),
        ).some(result => result.querySelector('.document-search-result-match')?.textContent?.includes(`Match ${targetMatch}`)), {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, searchMatchScrollConfig.targetMatch);

        await session.page.evaluate(() => {
            const diagnosticWindow = window as Window & {
                __clearPdfNavLog?: () => void;
                __clearPdfRenderTrace?: () => void;
            };
            diagnosticWindow.__clearPdfNavLog?.();
            diagnosticWindow.__clearPdfRenderTrace?.();
        });
        const clickedTarget = await session.page.evaluate((targetMatch: number) => {
            const result = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result',
            )).find(candidate => candidate.querySelector('.document-search-result-match')?.textContent?.includes(`Match ${targetMatch}`));
            result?.click();
            return Boolean(result);
        }, searchMatchScrollConfig.targetMatch);
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
            const viewerRect = viewer?.getBoundingClientRect();
            const highlights = Array.from(page?.querySelectorAll<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            ) ?? []).map(highlight => highlight.getBoundingClientRect())
                .filter(rect => rect.width > 0 && rect.height > 0);
            if (!currentResult?.textContent?.includes(`Match ${targetMatch}`)
                || !viewer
                || !page
                || !viewerRect
                || highlights.length === 0) {
                return false;
            }

            const highlightRect = {
                bottom: Math.max(...highlights.map(rect => rect.bottom)),
                left: Math.min(...highlights.map(rect => rect.left)),
                right: Math.max(...highlights.map(rect => rect.right)),
                top: Math.min(...highlights.map(rect => rect.top)),
            };
            const highlightCenterY = (highlightRect.top + highlightRect.bottom) / 2;
            const viewerCenterY = viewerRect.top + viewerRect.height / 2;
            const trace = ((window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload?: Record<string, unknown>
            }>;}).__getPdfRenderTrace?.() ?? []);
            const refined = trace.find(entry => (
                entry.event === 'navigation-text-anchor-refined'
                && entry.payload?.hasResolvedRect === true
            ));
            const appliedCount = refined?.payload?.intentId === undefined
                ? 0
                : trace.filter(entry => (
                    entry.event === 'navigation-viewport-authority-applied'
                    && entry.payload?.intentId === refined.payload?.intentId
                )).length;
            return currentResult.textContent.includes(`Match ${targetMatch}`)
                && highlightRect.top >= viewerRect.top - 2
                && highlightRect.bottom <= viewerRect.bottom + 2
                && Math.abs(highlightCenterY - viewerCenterY) < 120
                && appliedCount === 1;
        }, {timeout: SEARCH_MATCH_SCROLL_TIMEOUT_MS}, {
            targetMatch: searchMatchScrollConfig.targetMatch,
            targetPage: searchMatchScrollConfig.targetViewerPage,
        });

        const finalState = await session.page.evaluate((targetPage: number) => {
            const viewer = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host #pdf-viewer');
            const page = viewer?.querySelector<HTMLElement>(`.page_container[data-page="${String(targetPage)}"]`);
            const viewerRect = viewer?.getBoundingClientRect() ?? null;
            const highlightElement = page?.querySelector<HTMLElement>(
                '.pdf-search-highlight--current, .pdf-word-box--current',
            );
            const highlight = highlightElement?.getBoundingClientRect() ?? null;
            const trace = ((window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload?: Record<string, unknown>
            }>;}).__getPdfRenderTrace?.() ?? []);
            const refined = trace.find(entry => (
                entry.event === 'navigation-text-anchor-refined'
                && entry.payload?.hasResolvedRect === true
            ));
            const appliedCount = refined?.payload?.intentId === undefined
                ? 0
                : trace.filter(entry => (
                    entry.event === 'navigation-viewport-authority-applied'
                    && entry.payload?.intentId === refined.payload?.intentId
                )).length;
            return {
                highlight: highlight
                    ? {
                        bottom: highlight.bottom,
                        top: highlight.top,
                    }
                    : null,
                scrollTop: viewer?.scrollTop ?? null,
                appliedCount,
                trace: trace.filter(entry => [
                    'navigation-text-anchor-refined',
                    'navigation-viewport-authority-applied',
                ].includes(entry.event)),
                viewer: viewerRect
                    ? {
                        bottom: viewerRect.bottom,
                        top: viewerRect.top,
                    }
                    : null,
            };
        }, searchMatchScrollConfig.targetViewerPage);
        expect(finalState.highlight).not.toBeNull();
        expect(finalState.viewer).not.toBeNull();
        expect(finalState.appliedCount).toBe(1);
        expect(finalState.highlight!.top).toBeGreaterThanOrEqual(finalState.viewer!.top - 2);
        expect(finalState.highlight!.bottom).toBeLessThanOrEqual(finalState.viewer!.bottom + 2);
    }, SEARCH_MATCH_SCROLL_TIMEOUT_MS);
});
