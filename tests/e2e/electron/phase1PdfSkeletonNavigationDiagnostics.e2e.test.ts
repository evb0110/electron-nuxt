import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { openPdfInApp } from '@tests/e2e/electron/helpers/viewerCore';

const TARGET_PDF_PATH = process.env.EVB_E2E_NAVIGATION_PDF_PATH
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

interface IWorkspaceComponentElement extends HTMLElement {__vueParentComponent?: {
    exposed?: IWorkspaceExpose;
    parent?: IWorkspaceComponentElement['__vueParentComponent'];
};}

interface IWorkspaceToolbarSnapshot {
    effectiveZoom: number;
    continuousScroll: boolean;
    fitMode?: 'width' | 'height';
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    currentPage?: number;
    totalPages?: number;
}

interface IWorkspaceExpose {
    getToolbarSnapshot?: () => IWorkspaceToolbarSnapshot;
    handleActualSize?: () => void;
    handleZoomIn?: () => void;
    handleFitHeight?: () => void;
    handleGoToPage?: (page: number) => void;
    handleViewModeSingle?: () => void;
    handleToggleContinuousScroll?: () => void;
}

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

async function goToPageViaWorkspace(session: IElectronE2ESession, pageNumber: number) {
    const didNavigate = await session.page.evaluate((targetPage: number) => {
        function isVisibleElement(element: HTMLElement) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 100
                && rect.height > 100;
        }

        function findWorkspaceExpose() {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const hosts = [
                ...(activeHost ? [activeHost] : []),
                ...Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')),
                ...Array.from(document.querySelectorAll<HTMLElement>('*')),
            ];
            for (const element of hosts) {
                if (!isVisibleElement(element)) {
                    continue;
                }

                let component = (element as IWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (
                        typeof exposed?.getToolbarSnapshot === 'function'
                        && typeof exposed.handleGoToPage === 'function'
                    ) {
                        return exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

        const workspace = findWorkspaceExpose();
        workspace?.handleGoToPage?.(targetPage);
        return Boolean(workspace);
    }, pageNumber);

    if (!didNavigate) {
        await enterPageInToolbar(session, String(pageNumber));
    }
}

async function collectNavigationDiagnosticsSnapshot(session: IElectronE2ESession) {
    return session.page.evaluate((): INavigationDiagnosticsSnapshot => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        function findWorkspaceExpose() {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const hosts = [
                ...(activeHost ? [activeHost] : []),
                ...Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')),
                ...Array.from(document.querySelectorAll<HTMLElement>('*')),
            ];
            for (const element of hosts) {
                if (!isVisibleElement(element)) {
                    continue;
                }

                let component = (element as IWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (typeof exposed?.getToolbarSnapshot === 'function') {
                        return exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

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
            toolbarSnapshot: findWorkspaceExpose()?.getToolbarSnapshot?.() ?? null,
            visiblePages,
        };
    });
}

async function configureHighZoom(session: IElectronE2ESession, options: { continuousScroll: boolean } = { continuousScroll: false }) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const configured = await session.page.evaluate((configuration: { continuousScroll: boolean }) => {
        function findWorkspaceExpose() {
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                let component = (element as IWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (
                        typeof exposed?.getToolbarSnapshot === 'function'
                        && typeof exposed.handleZoomIn === 'function'
                    ) {
                        return exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

        const workspace = findWorkspaceExpose();
        if (!workspace) {
            return false;
        }

        workspace.handleViewModeSingle?.();
        const isContinuousScroll = workspace.getToolbarSnapshot?.().continuousScroll === true;
        if (configuration.continuousScroll !== isContinuousScroll) {
            workspace.handleToggleContinuousScroll?.();
        }
        workspace.handleActualSize?.();
        for (let index = 0; index < 30; index += 1) {
            if ((workspace.getToolbarSnapshot?.().effectiveZoom ?? 0) >= 3.4) {
                break;
            }
            workspace.handleZoomIn?.();
        }
        return true;
    }, options);

    if (!configured) {
        throw new Error('Unable to configure workspace zoom/page state');
    }

    await delay(500);
}

async function configureSinglePagedFitHeightMode(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const configured = await session.page.evaluate(() => {
        function findWorkspaceExpose() {
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                let component = (element as IWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (
                        typeof exposed?.getToolbarSnapshot === 'function'
                        && typeof exposed.handleFitHeight === 'function'
                        && typeof exposed.handleViewModeSingle === 'function'
                    ) {
                        return exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

        const workspace = findWorkspaceExpose();
        if (!workspace) {
            return false;
        }

        workspace.handleViewModeSingle?.();
        if (workspace.getToolbarSnapshot?.().continuousScroll === true) {
            workspace.handleToggleContinuousScroll?.();
        }
        workspace.handleFitHeight?.();
        return true;
    });

    if (!configured) {
        throw new Error('Unable to configure single-page paged fit-height mode');
    }

    await delay(500);
}

async function waitForToolbarPage(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((targetPage: number) => {
        function isVisibleElement(element: HTMLElement) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        }

        function findWorkspaceExpose() {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const hosts = [
                ...(activeHost ? [activeHost] : []),
                ...Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')),
                ...Array.from(document.querySelectorAll<HTMLElement>('*')),
            ];
            for (const element of hosts) {
                if (!isVisibleElement(element)) {
                    continue;
                }

                let component = (element as IWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (typeof exposed?.getToolbarSnapshot === 'function') {
                        return exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

        const snapshot = findWorkspaceExpose()?.getToolbarSnapshot?.();
        if (snapshot?.currentPage === targetPage) {
            return true;
        }

        return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .some((element) => {
                return element.textContent?.trim() === String(targetPage)
                    && isVisibleElement(element);
            });
    }, { timeout: 15_000 }, pageNumber);
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

describe('Electron E2E - PDF Navigation Skeleton Diagnostics', () => {
    let session: IElectronE2ESession | null = null;

    beforeAll(async () => {
        if (!existsSync(TARGET_PDF_PATH)) {
            return;
        }
        session = await startElectronE2ESession(`e2e-girgas-skeleton-${Date.now()}`);
        await enablePdfNavLog(session);
        await openPdfInApp(session.page, TARGET_PDF_PATH, 60_000);
        await enablePdfNavLog(session);
    }, 120_000);

    afterAll(async () => {
        await session?.stop();
    });

    it.runIf(existsSync(TARGET_PDF_PATH))('does not show a page skeleton during high-zoom next-page navigation', async () => {
        if (!session) {
            throw new Error('Diagnostic session was not initialized');
        }

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

        expect(skeletonSamples).toEqual([]);
        expect(skeletonLogEntries).toEqual([]);
    }, 90_000);

    it.runIf(existsSync(TARGET_PDF_PATH))('renders after entering page 500 in the toolbar', async () => {
        if (!session) {
            throw new Error('Diagnostic session was not initialized');
        }

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
        expect(lastSample?.skeletonPages).toEqual([]);
        expect(lastSample?.canvasPages.length ?? 0).toBeGreaterThan(0);
    }, 90_000);

    it.runIf(existsSync(TARGET_PDF_PATH))('renders the last page after rapid next-page navigation', async () => {
        if (!session) {
            throw new Error('Diagnostic session was not initialized');
        }

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
        expect(lastSample?.skeletonPages).toEqual([]);
        expect(finalSnapshot?.toolbarSnapshot?.currentPage).toBe(928);
        expect(finalSnapshot?.toolbarSnapshot?.fitMode).toBe('height');
        expect(finalSnapshot?.visiblePages.some(page => page.page === 928 && page.hasSkeleton)).toBe(false);
        expect(finalSnapshot?.visiblePages.some(page => page.page === 928 && page.hasCanvas)).toBe(true);
    }, 130_000);
});
