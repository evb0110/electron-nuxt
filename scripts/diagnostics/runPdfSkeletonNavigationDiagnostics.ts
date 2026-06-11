import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { delay } from 'es-toolkit/promise';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type { IWorkspaceToolbarSnapshot } from '@tests/e2e/electron/helpers/workspaceExpose';

const TARGET_PDF_PATH = process.env.EVB_E2E_NAVIGATION_PDF_PATH
    || process.env.EVB_DIAGNOSTIC_PDF_PATH
    || resolve(process.cwd(), '.devkit', 'manual-pdf-fixtures', 'navigation-source.pdf');
const DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-page-navigation-skeleton-diagnostics.json',
);
const DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-page-500-input-skeleton-diagnostics.json',
);
const RAPID_NEXT_TO_LAST_DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-rapid-next-to-last-skeleton-diagnostics.json',
);

type TPdfNavLogEntry = {
    message: string;
    args: unknown[];
    loggedAtMs: number;
};

type TPdfRenderTraceEntry = {
    event: string;
    payload: Record<string, unknown>;
};

type TNavigationSample = {
    sampledAtMs: number;
    currentPageText: string | null;
    skeletonPages: number[];
    renderedPages: number[];
    canvasPages: number[];
};

interface IVisiblePageDiagnostics {
    page: number;
    className: string;
    rendered: boolean;
    buffered: boolean;
    hasSkeleton: boolean;
    hasCanvas: boolean;
    canvasCount: number;
    textSpanCount: number;
    rectTop: number;
    rectBottom: number;
    rectHeight: number;
}

interface INavigationDiagnosticsSnapshot {
    pageControlsText: string;
    scrollTop: number | null;
    visibleRangeText: string | null;
    toolbarSnapshot: IWorkspaceToolbarSnapshot | null;
    visiblePages: IVisiblePageDiagnostics[];
}

function writeDiagnosticArtifact(payload: unknown) {
    mkdirSync(dirname(DIAGNOSTIC_OUTPUT_PATH), { recursive: true });
    writeFileSync(DIAGNOSTIC_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeDirectJumpDiagnosticArtifact(payload: unknown) {
    mkdirSync(dirname(DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH), { recursive: true });
    writeFileSync(DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeRapidNextToLastDiagnosticArtifact(payload: unknown) {
    mkdirSync(dirname(RAPID_NEXT_TO_LAST_DIAGNOSTIC_OUTPUT_PATH), { recursive: true });
    writeFileSync(RAPID_NEXT_TO_LAST_DIAGNOSTIC_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

async function enablePdfNavLog(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        localStorage.setItem('evb-viewer:pdf-nav-log', '1');
        localStorage.removeItem('evb-viewer:pdf-nav-log-console');
        localStorage.setItem('evb-viewer:pdf-render-trace', '1');
        localStorage.removeItem('evb-viewer:pdf-render-trace-console');
        const logWindow = window as Window & {
            __pdfNavLog?: boolean;
            __pdfNavLogConsole?: boolean;
            __clearPdfNavLog?: () => void;
            __pdfRenderTrace?: boolean;
            __pdfRenderTraceConsole?: boolean;
            __clearPdfRenderTrace?: () => void;
        };
        logWindow.__pdfNavLog = true;
        logWindow.__pdfNavLogConsole = false;
        logWindow.__clearPdfNavLog?.();
        logWindow.__pdfRenderTrace = true;
        logWindow.__pdfRenderTraceConsole = false;
        logWindow.__clearPdfRenderTrace?.();
    });
}

async function collectPdfNavLog(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const logWindow = window as Window & { __getPdfNavLog?: () => TPdfNavLogEntry[]; };
        return logWindow.__getPdfNavLog?.() ?? [];
    });
}

async function collectPdfRenderTrace(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const traceWindow = window as Window & { __getPdfRenderTrace?: () => TPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

function isExecutionContextDestroyedError(error: unknown) {
    return error instanceof Error
        && /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}

async function waitForWorkspaceReady(
    page: IElectronE2ESession['page'],
    timeoutMs = 60_000,
) {
    await waitForWorkspaceToolbarSnapshot(page, {
        hasPdf: true,
        minTotalPages: 2,
    }, { timeoutMs });
    await page.waitForSelector('#pdf-viewer', { timeout: timeoutMs });
}

async function openPdfInApp(
    page: IElectronE2ESession['page'],
    pdfPath: string,
    timeoutMs: number,
) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await page.evaluate(async (path: string) => {
                const automationWindow = window as Window & {
                    __allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;
                    __openFileDirect?: (value: string) => Promise<boolean>;
                    electronAPI?: {documents?: {recentFiles?: {add?: (value: string) => Promise<void>;};};};
                };

                const automationGrant = automationWindow.__allowRendererFileOpenForAutomation;
                if (typeof automationGrant === 'function') {
                    await automationGrant(path);
                }

                try {
                    await automationWindow.electronAPI?.documents?.recentFiles?.add?.(path);
                } catch {
                    // Recent-file writes are not required for diagnostics.
                }

                const openFileDirect = automationWindow.__openFileDirect;
                if (typeof openFileDirect !== 'function') {
                    throw new Error('window.__openFileDirect is not available');
                }
                await openFileDirect(path);
            }, pdfPath);
            await waitForWorkspaceReady(page, timeoutMs);
            return;
        } catch (error) {
            lastError = error;
            if (!isExecutionContextDestroyedError(error)) {
                throw error;
            }

            try {
                await waitForWorkspaceReady(page, 10_000);
                return;
            } catch {
                await delay(1_000);
            }
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to open PDF in app: ${String(lastError)}`);
}

async function goToPageViaWorkspace(session: IElectronE2ESession, pageNumber: number) {
    const navigationResult = await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber], {
        requiredMethods: ['getToolbarSnapshot'],
        requireVisible: true,
    });

    if (!navigationResult.called) {
        await enterPageInToolbar(session, String(pageNumber));
    }
}

async function collectNavigationDiagnosticsSnapshot(session: IElectronE2ESession) {
    const snapshot = await session.page.evaluate((): Omit<INavigationDiagnosticsSnapshot, 'toolbarSnapshot'> => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };

        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        const viewportRect = viewer?.getBoundingClientRect() ?? {
            top: 0,
            bottom: window.innerHeight,
        };
        const visiblePageControls = Array.from(document.querySelectorAll<HTMLElement>('.page-controls'))
            .find(isVisibleElement);
        const visibleCurrentPageLabel = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .find(isVisibleElement);
        const visiblePages = Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
            .map((container): IVisiblePageDiagnostics => {
                const rect = container.getBoundingClientRect();
                return {
                    page: Number(container.dataset.page) || 0,
                    className: container.className,
                    rendered: container.classList.contains('page_container--rendered'),
                    buffered: container.classList.contains('page_container--buffered'),
                    hasSkeleton: Boolean(container.querySelector('.pdf-page-skeleton')),
                    hasCanvas: Boolean(container.querySelector('.page_canvas canvas')),
                    canvasCount: container.querySelectorAll('.page_canvas canvas').length,
                    textSpanCount: container.querySelectorAll('.text-layer span, .textLayer span').length,
                    rectTop: rect.top,
                    rectBottom: rect.bottom,
                    rectHeight: rect.height,
                };
            })
            .filter(page => page.rectBottom >= viewportRect.top && page.rectTop <= viewportRect.bottom);

        return {
            pageControlsText: visiblePageControls?.innerText ?? '',
            scrollTop: viewer?.scrollTop ?? null,
            visibleRangeText: visibleCurrentPageLabel?.textContent?.trim() ?? null,
            visiblePages,
        };
    });
    const toolbarSnapshot = await getWorkspaceToolbarSnapshot(session.page, {requireVisible: true});
    return {
        ...snapshot,
        toolbarSnapshot,
    };
}

async function configureHighZoom(session: IElectronE2ESession, options: { continuousScroll: boolean } = { continuousScroll: false }) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const initialSnapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: ['handleZoomIn']});

    if (!initialSnapshot) {
        throw new Error('Unable to configure workspace zoom/page state');
    }

    await callWorkspaceCommand(session.page, 'handleViewModeSingle', [], {requiredMethods: [
        'getToolbarSnapshot',
        'handleZoomIn',
    ]});
    if (options.continuousScroll !== (initialSnapshot.continuousScroll === true)) {
        await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll', [], {requiredMethods: [
            'getToolbarSnapshot',
            'handleZoomIn',
        ]});
    }
    await callWorkspaceCommand(session.page, 'handleActualSize', [], {requiredMethods: [
        'getToolbarSnapshot',
        'handleZoomIn',
    ]});
    for (let index = 0; index < 30; index += 1) {
        const snapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: ['handleZoomIn']});
        if ((snapshot?.effectiveZoom ?? 0) >= 3.4) {
            break;
        }
        await callWorkspaceCommand(session.page, 'handleZoomIn', [], {requiredMethods: ['getToolbarSnapshot']});
    }
    await delay(500);
}

async function configureSinglePagedFitHeightMode(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const initialSnapshot = await getWorkspaceToolbarSnapshot(session.page, {requiredMethods: [
        'handleFitHeight',
        'handleViewModeSingle',
    ]});

    if (!initialSnapshot) {
        throw new Error('Unable to configure single-page paged fit-height mode');
    }

    await callWorkspaceCommand(session.page, 'handleViewModeSingle', [], {requiredMethods: [
        'getToolbarSnapshot',
        'handleFitHeight',
    ]});
    if (initialSnapshot.continuousScroll === true) {
        await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll', [], {requiredMethods: [
            'getToolbarSnapshot',
            'handleFitHeight',
        ]});
    }
    await callWorkspaceCommand(session.page, 'handleFitHeight', [], {requiredMethods: ['getToolbarSnapshot']});
    await delay(500);
}

async function waitForToolbarPage(session: IElectronE2ESession, pageNumber: number) {
    await Promise.any([
        waitForWorkspaceToolbarSnapshot(session.page, { currentPage: pageNumber }, { timeoutMs: 15_000 }),
        session.page.waitForFunction((targetPage: number) => {
            const isVisibleElement = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .some((element) => {
                    return element.textContent?.trim() === String(targetPage)
                        && isVisibleElement(element);
                });
        }, { timeout: 15_000 }, pageNumber),
    ]);
}

async function clickPageNavigationButton(session: IElectronE2ESession, label: string) {
    await session.page.waitForFunction((targetLabel: string) => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .some(button => {
                const ariaLabel = button.getAttribute('aria-label')?.trim() ?? '';
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return (ariaLabel === targetLabel || ariaLabel.startsWith(`${targetLabel} (`))
                    && !button.disabled
                    && button.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 30_000 }, label);

    const clicked = await session.page.evaluate((targetLabel: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .find((candidate) => {
                const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (ariaLabel === targetLabel || ariaLabel.startsWith(`${targetLabel} (`))
                    && !candidate.disabled
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        button?.click();
        return Boolean(button);
    }, label);

    if (!clicked) {
        throw new Error(`Unable to click the ${label} toolbar button`);
    }
}

async function clickNextPage(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button'))
            .some(button => {
                const label = button.getAttribute('aria-label') ?? '';
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return label === 'Next Page'
                    && !button.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 30_000 });
    const clicked = await session.page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button'));
        const isVisibleEnabled = (candidate: HTMLButtonElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return !candidate.disabled
                && rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const button = candidates.find((candidate) => {
            const label = candidate.getAttribute('aria-label') ?? '';
            const hasNextIcon = Boolean(candidate.querySelector('.i-ph-caret-right, .iconify.i-ph-caret-right'));
            return (label.startsWith('Next Page') || hasNextIcon) && isVisibleEnabled(candidate);
        })
            ?? candidates.filter(isVisibleEnabled)[0]
            ?? null;
        button?.click();
        return Boolean(button);
    });
    if (!clicked) {
        const state = await session.page.evaluate(() => ({
            pageControlsCount: document.querySelectorAll('.page-controls').length,
            pageControlsHtml: Array.from(document.querySelectorAll<HTMLElement>('.page-controls'))
                .map(element => element.outerHTML.slice(0, 1000)),
            buttonLabels: Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
                .map(button => ({
                    className: button.className,
                    label: button.getAttribute('aria-label'),
                    disabled: button.disabled,
                    text: button.textContent?.trim() ?? '',
                }))
                .slice(0, 50),
        }));
        throw new Error(`Unable to click the Next Page toolbar button: ${JSON.stringify(state)}`);
    }
}

async function rapidClickNextPages(session: IElectronE2ESession, count: number) {
    for (let index = 0; index < count; index += 1) {
        await clickPageNavigationButton(session, 'Next Page');
    }
}

async function waitForPageCanvas(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((targetPage: number) => {
        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPage}"]`);
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && container.querySelector('.page_canvas canvas'),
        );
    }, { timeout: 20_000 }, pageNumber);
}

async function enterPageInToolbar(session: IElectronE2ESession, pageInput: string) {
    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls-display'))
            .some(button => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return !button.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 30_000 });

    const clicked = await session.page.evaluate(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls-display'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return !candidate.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        button?.click();
        return Boolean(button);
    });
    if (!clicked) {
        throw new Error('Unable to click the page display');
    }

    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .some(input => {
                const rect = input.getBoundingClientRect();
                const style = window.getComputedStyle(input);
                return rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 10_000 });

    await session.page.keyboard.type(pageInput);
    await session.page.keyboard.press('Enter');
}

async function navigateToPageWithNextButton(session: IElectronE2ESession, pageNumber: number) {
    for (let target = 2; target <= pageNumber; target += 1) {
        await clickNextPage(session);
        await waitForToolbarPage(session, target);
    }
    await waitForPageCanvas(session, pageNumber);
}

async function navigateForwardWithNextButton(session: IElectronE2ESession, steps: number) {
    for (let step = 0; step < steps; step += 1) {
        const currentPage = await session.page.evaluate(() => {
            const text = document.querySelector<HTMLElement>('.page-controls-current-primary')?.textContent?.trim() ?? '';
            return Number.parseInt(text, 10);
        });
        await clickNextPage(session);
        if (Number.isFinite(currentPage)) {
            await waitForToolbarPage(session, currentPage + 1);
        }
    }
}

async function sampleNavigation(
    session: IElectronE2ESession,
    options: {
        count?: number;
        delayMs?: number;
    } = {},
) {
    const samples: TNavigationSample[] = [];
    const startedAt = Date.now();
    const count = options.count ?? 180;
    const delayMs = options.delayMs ?? 10;
    for (let index = 0; index < count; index += 1) {
        samples.push(await session.page.evaluate((startedAtMs: number): TNavigationSample => {
            const pageContainers = Array.from(document.querySelectorAll<HTMLElement>('.page_container'));
            const visiblePageContainers = pageContainers.filter((container) => {
                const rect = container.getBoundingClientRect();
                return rect.bottom > 0 && rect.top < window.innerHeight;
            });
            const pageNumber = (container: HTMLElement) => Number(container.dataset.page) || 0;
            const skeletonPages = visiblePageContainers
                .filter(container => Boolean(container.querySelector('.pdf-page-skeleton')))
                .map(pageNumber);
            const renderedPages = visiblePageContainers
                .filter(container => container.classList.contains('page_container--rendered'))
                .map(pageNumber);
            const canvasPages = visiblePageContainers
                .filter(container => Boolean(container.querySelector('.page_canvas canvas')))
                .map(pageNumber);
            const visibleCurrentPageLabel = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .find((element) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden';
                });
            return {
                sampledAtMs: Date.now() - startedAtMs,
                currentPageText: visibleCurrentPageLabel?.textContent?.trim() ?? null,
                skeletonPages,
                renderedPages,
                canvasPages,
            };
        }, startedAt));
        await delay(delayMs);
    }
    return samples;
}

function assertTargetPdfExists() {
    if (existsSync(TARGET_PDF_PATH)) {
        return;
    }

    throw new Error(
        [
            `PDF navigation diagnostic fixture not found: ${TARGET_PDF_PATH}`,
            'Set EVB_E2E_NAVIGATION_PDF_PATH or EVB_DIAGNOSTIC_PDF_PATH to a local PDF before running this diagnostic.',
        ].join('\n'),
    );
}

async function runHighZoomNextPageDiagnostic(session: IElectronE2ESession) {
    let samples: TNavigationSample[] = [];
    let navLog: TPdfNavLogEntry[] = [];
    let renderTrace: TPdfRenderTraceEntry[] = [];
    try {
        await navigateToPageWithNextButton(session, 55);
        await configureHighZoom(session);
        await waitForPageCanvas(session, 55);
        await delay(500);
        await enablePdfNavLog(session);
        await clickNextPage(session);
        samples = await sampleNavigation(session);
        navLog = await collectPdfNavLog(session);
        renderTrace = await collectPdfRenderTrace(session);
    } finally {
        if (samples.length === 0) {
            samples = await sampleNavigation(session).catch(() => []);
        }
        if (navLog.length === 0) {
            navLog = await collectPdfNavLog(session).catch(() => []);
        }
        if (renderTrace.length === 0) {
            renderTrace = await collectPdfRenderTrace(session).catch(() => []);
        }
        writeDiagnosticArtifact({
            pdfPath: TARGET_PDF_PATH,
            scenario: 'page-55-next-to-56-zoom-344',
            samples,
            navLog,
            renderTrace,
            skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
            skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
        });
    }

    const skeletonSamples = samples.filter(sample => sample.skeletonPages.length > 0);
    const skeletonLogEntries = navLog.filter(entry => entry.message.includes('page skeleton visible'));

    assert.deepEqual(skeletonSamples, []);
    assert.deepEqual(skeletonLogEntries, []);
}

async function runToolbarPageInputDiagnostic(session: IElectronE2ESession) {
    let samples: TNavigationSample[] = [];
    let navLog: TPdfNavLogEntry[] = [];
    let renderTrace: TPdfRenderTraceEntry[] = [];
    try {
        await navigateForwardWithNextButton(session, 3);
        await configureHighZoom(session, { continuousScroll: true });
        await enablePdfNavLog(session);
        await enterPageInToolbar(session, '500');
        samples = await sampleNavigation(session);
        navLog = await collectPdfNavLog(session);
        renderTrace = await collectPdfRenderTrace(session);
    } finally {
        if (samples.length === 0) {
            samples = await sampleNavigation(session).catch(() => []);
        }
        if (navLog.length === 0) {
            navLog = await collectPdfNavLog(session).catch(() => []);
        }
        if (renderTrace.length === 0) {
            renderTrace = await collectPdfRenderTrace(session).catch(() => []);
        }
        writeDirectJumpDiagnosticArtifact({
            pdfPath: TARGET_PDF_PATH,
            scenario: 'toolbar-enter-page-500-after-navigation-zoom-344',
            samples,
            navLog,
            renderTrace,
            skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
            canvasSamples: samples.filter(sample => sample.canvasPages.length > 0),
            lastSample: samples.at(-1) ?? null,
            skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
        });
    }

    const lastSample = samples.at(-1);
    assert.deepEqual(lastSample?.skeletonPages, []);
    assert.ok((lastSample?.canvasPages.length ?? 0) > 0);
}

async function runRapidNextToLastPageDiagnostic(session: IElectronE2ESession) {
    let samples: TNavigationSample[] = [];
    let navLog: TPdfNavLogEntry[] = [];
    let renderTrace: TPdfRenderTraceEntry[] = [];
    let finalSnapshot: INavigationDiagnosticsSnapshot | null = null;
    try {
        await delay(2_000);
        await goToPageViaWorkspace(session, 1);
        await waitForToolbarPage(session, 1);
        await configureSinglePagedFitHeightMode(session);
        await waitForToolbarPage(session, 1);
        await delay(500);
        await enablePdfNavLog(session);

        await rapidClickNextPages(session, 29);
        await waitForToolbarPage(session, 30);
        await clickPageNavigationButton(session, 'Last Page');
        await waitForToolbarPage(session, 928);

        samples = await sampleNavigation(session, {
            count: 500,
            delayMs: 25,
        });
        finalSnapshot = await collectNavigationDiagnosticsSnapshot(session);
        navLog = await collectPdfNavLog(session);
        renderTrace = await collectPdfRenderTrace(session);
    } finally {
        if (samples.length === 0) {
            samples = await sampleNavigation(session, {
                count: 120,
                delayMs: 25,
            }).catch(() => []);
        }
        finalSnapshot ??= await collectNavigationDiagnosticsSnapshot(session).catch(() => null);
        if (navLog.length === 0) {
            navLog = await collectPdfNavLog(session).catch(() => []);
        }
        if (renderTrace.length === 0) {
            renderTrace = await collectPdfRenderTrace(session).catch(() => []);
        }
        writeRapidNextToLastDiagnosticArtifact({
            pdfPath: TARGET_PDF_PATH,
            scenario: 'fit-height-rapid-next-1-to-30-then-last-page',
            samples,
            finalSnapshot,
            navLog,
            renderTrace,
            skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
            canvasSamples: samples.filter(sample => sample.canvasPages.length > 0),
            lastSample: samples.at(-1) ?? null,
            skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
        });
    }

    const lastSample = samples.at(-1);
    assert.deepEqual(lastSample?.skeletonPages, []);
    assert.equal(finalSnapshot?.toolbarSnapshot?.currentPage, 928);
    assert.equal(finalSnapshot?.toolbarSnapshot?.fitMode, 'height');
    assert.equal(finalSnapshot?.visiblePages.some(page => page.page === 928 && page.hasSkeleton), false);
    assert.equal(finalSnapshot?.visiblePages.some(page => page.page === 928 && page.hasCanvas), true);
}

export async function runPdfSkeletonNavigationDiagnostics() {
    assertTargetPdfExists();

    const session = await startElectronE2ESession(`diagnostic-girgas-skeleton-${Date.now()}`);
    try {
        await enablePdfNavLog(session);
        await openPdfInApp(session.page, TARGET_PDF_PATH, 60_000);
        await enablePdfNavLog(session);

        await runHighZoomNextPageDiagnostic(session);
        await runToolbarPageInputDiagnostic(session);
        await runRapidNextToLastPageDiagnostic(session);
    } finally {
        await session.stop();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await runPdfSkeletonNavigationDiagnostics().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
