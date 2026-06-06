import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { delay } from 'es-toolkit/promise';
import {
    type IDiagnosticFrameCaptureResult,
    startDiagnosticFrameCapture,
} from '@scripts/diagnostics/diagnosticFrameCapture';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';

const DEFAULT_TARGET_PDF_PATH = process.env.EVB_DIAGNOSTIC_PDF_PATH
    || resolve(process.cwd(), '.devkit', 'manual-pdf-fixtures', 'navigation-source.pdf');
const DEFAULT_OUT_PATH = '.devkit/pdf-navigation-blink-trace.json';

export interface IOptions {
    clicks: number;
    clickDelayMs: number;
    out: string;
    pdf: string;
    settleMs: number;
    startPage: number;
    video: boolean;
    videoDir: string | null;
    videoFps: number;
}

interface ITraceSummary {
    blankSampleCount: number;
    frameAnalysis: IFrameAnalysisSummary;
    firstBlankSample: unknown;
    maxBlankRunMs: number;
    skeletonSampleCount: number;
    toolbarPages: number[];
    workspaceGoToPages: number[];
    pagedTargets: number[];
}

export interface IFrameAnalysisSummary {
    canvasObservedAtMs: number | null;
    firstSkeletonAfterCanvasAtMs: number | null;
    skeletonAfterCanvasObserved: boolean;
    skeletonAfterCanvasPages: number[];
}

export function readOptions(argv = process.argv.slice(2)): IOptions {
    const options: IOptions = {
        clicks: 12,
        clickDelayMs: 20,
        out: DEFAULT_OUT_PATH,
        pdf: DEFAULT_TARGET_PDF_PATH,
        settleMs: 2_000,
        startPage: 1,
        video: false,
        videoDir: null,
        videoFps: 30,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--clicks' && next) {
            options.clicks = Math.max(1, Number.parseInt(next, 10) || options.clicks);
            index += 1;
        } else if (arg === '--click-delay-ms' && next) {
            options.clickDelayMs = Math.max(0, Number.parseInt(next, 10) || options.clickDelayMs);
            index += 1;
        } else if (arg === '--out' && next) {
            options.out = next;
            index += 1;
        } else if (arg === '--pdf' && next) {
            options.pdf = next;
            index += 1;
        } else if (arg === '--settle-ms' && next) {
            options.settleMs = Math.max(0, Number.parseInt(next, 10) || options.settleMs);
            index += 1;
        } else if (arg === '--start-page' && next) {
            options.startPage = Math.max(1, Number.parseInt(next, 10) || options.startPage);
            index += 1;
        } else if (arg === '--video') {
            options.video = true;
        } else if (arg === '--video-dir' && next) {
            options.video = true;
            options.videoDir = next;
            index += 1;
        } else if (arg === '--video-fps' && next) {
            options.videoFps = Math.max(1, Number.parseInt(next, 10) || options.videoFps);
            index += 1;
        }
    }

    return options;
}

export function resolveVideoDirectory(options: Pick<IOptions, 'out' | 'videoDir'>, cwd = process.cwd()) {
    if (options.videoDir) {
        return resolve(cwd, options.videoDir);
    }

    const outPath = resolve(cwd, options.out);
    const withoutJsonExtension = outPath.endsWith('.json')
        ? outPath.slice(0, -'.json'.length)
        : outPath;
    return `${withoutJsonExtension}-video`;
}

async function enablePdfDiagnostics(page: Awaited<ReturnType<typeof startElectronE2ESession>>['page']) {
    await page.evaluate(() => {
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

function isExecutionContextDestroyedError(error: unknown) {
    return error instanceof Error
        && /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}

async function openPdfInApp(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
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

async function installBlinkSampler(page: Awaited<ReturnType<typeof startElectronE2ESession>>['page']) {
    await page.evaluate(() => {
        type TWorkspaceExpose = {getToolbarSnapshot?: () => {
            currentPage?: number;
            totalPages?: number;
            fitMode?: string;
            zoomMode?: string;
            continuousScroll?: boolean;
            effectiveZoom?: number;
        };};
        type TWorkspaceComponentElement = HTMLElement & {__vueParentComponent?: {
            exposed?: TWorkspaceExpose;
            parent?: TWorkspaceComponentElement['__vueParentComponent'];
        };};
        type TBlinkTraceWindow = Window & {
            __pdfBlinkTrace?: {
                events: unknown[];
                samples: unknown[];
                startedAtMs: number;
            };
            __pdfBlinkTraceRunning?: boolean;
            __pdfBlinkTraceObserver?: MutationObserver;
            __recordPdfBlinkEvent?: (kind: string, payload?: unknown) => void;
            __startPdfBlinkTrace?: () => void;
            __stopPdfBlinkTrace?: () => unknown;
        };
        const traceWindow = window as TBlinkTraceWindow;

        function nowMs() {
            return Math.round((performance.now() - (traceWindow.__pdfBlinkTrace?.startedAtMs ?? performance.now())) * 10) / 10;
        }

        function isVisibleElement(element: HTMLElement) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        }

        function findWorkspaceExpose() {
            const candidates = [
                ...Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active .workspace-host')),
                ...Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')),
                ...Array.from(document.querySelectorAll<HTMLElement>('*')),
            ];
            for (const element of candidates) {
                if (!isVisibleElement(element)) {
                    continue;
                }
                let component = (element as TWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    if (typeof component.exposed?.getToolbarSnapshot === 'function') {
                        return component.exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

        function summarizeElement(element: Element | null) {
            if (!(element instanceof HTMLElement)) {
                return null;
            }
            return {
                tagName: element.tagName,
                className: String(element.className),
                text: element.textContent?.trim().slice(0, 80) ?? '',
                page: element.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
            };
        }

        function recordEvent(kind: string, payload: unknown = {}) {
            const trace = traceWindow.__pdfBlinkTrace;
            if (!trace) {
                return;
            }
            trace.events.push({
                kind,
                atMs: nowMs(),
                payload,
            });
        }

        function collectSample() {
            const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
            const viewerRect = viewer?.getBoundingClientRect() ?? {
                top: 0,
                bottom: window.innerHeight,
                left: 0,
                right: window.innerWidth,
                width: window.innerWidth,
                height: window.innerHeight,
            };
            const visibleCurrentPageLabels = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .filter(isVisibleElement)
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        text: element.textContent?.trim() ?? '',
                        top: Math.round(rect.top),
                        left: Math.round(rect.left),
                    };
                });
            const visiblePages = Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
                .map((container) => {
                    const rect = container.getBoundingClientRect();
                    const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
                    const skeletonStyle = skeleton ? window.getComputedStyle(skeleton) : null;
                    const canvases = Array.from(container.querySelectorAll<HTMLCanvasElement>('.page_canvas canvas'));
                    const pageCanvas = container.querySelector<HTMLElement>('.page_canvas');
                    return {
                        page: Number(container.dataset.page) || 0,
                        top: Math.round(rect.top),
                        bottom: Math.round(rect.bottom),
                        height: Math.round(rect.height),
                        className: container.className,
                        rendered: container.classList.contains('page_container--rendered'),
                        buffered: container.classList.contains('page_container--buffered'),
                        hasSkeleton: Boolean(skeleton),
                        skeletonDisplay: skeletonStyle?.display ?? null,
                        skeletonOpacity: skeletonStyle?.opacity ?? null,
                        hasCanvas: canvases.length > 0,
                        canvasCount: canvases.length,
                        canvasSizes: canvases.map(canvas => ({
                            width: canvas.width,
                            height: canvas.height,
                            clientWidth: Math.round(canvas.getBoundingClientRect().width),
                            clientHeight: Math.round(canvas.getBoundingClientRect().height),
                        })),
                        pageCanvasChildren: pageCanvas?.children.length ?? 0,
                    };
                })
                .filter(pageInfo => pageInfo.bottom >= viewerRect.top && pageInfo.top <= viewerRect.bottom);
            const blankVisiblePages = visiblePages
                .filter(pageInfo => !pageInfo.hasSkeleton && !pageInfo.hasCanvas)
                .map(pageInfo => pageInfo.page);
            const skeletonPages = visiblePages
                .filter(pageInfo => pageInfo.hasSkeleton)
                .map(pageInfo => pageInfo.page);
            const canvasPages = visiblePages
                .filter(pageInfo => pageInfo.hasCanvas)
                .map(pageInfo => pageInfo.page);
            const centerX = Math.round(viewerRect.left + viewerRect.width / 2);
            const centerY = Math.round(viewerRect.top + viewerRect.height / 2);

            return {
                atMs: nowMs(),
                toolbarSnapshot: findWorkspaceExpose()?.getToolbarSnapshot?.() ?? null,
                visibleCurrentPageLabels,
                viewer: viewer
                    ? {
                        scrollTop: Math.round(viewer.scrollTop),
                        clientHeight: viewer.clientHeight,
                        scrollHeight: viewer.scrollHeight,
                    }
                    : null,
                visiblePages,
                blankVisiblePages,
                skeletonPages,
                canvasPages,
                elementAtCenter: summarizeElement(document.elementFromPoint(centerX, centerY)),
            };
        }

        traceWindow.__pdfBlinkTraceObserver?.disconnect();
        traceWindow.__pdfBlinkTrace = {
            events: [],
            samples: [],
            startedAtMs: performance.now(),
        };
        traceWindow.__recordPdfBlinkEvent = recordEvent;

        document.addEventListener('click', (event) => {
            const button = (event.target as Element | null)?.closest?.('.page-controls button[aria-label]');
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }
            recordEvent('toolbar-button-click', {
                label: button.getAttribute('aria-label'),
                disabled: button.disabled,
                labels: Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                    .filter(isVisibleElement)
                    .map(element => element.textContent?.trim() ?? ''),
            });
        }, true);

        traceWindow.__pdfBlinkTraceObserver = new MutationObserver((mutations) => {
            const trace = traceWindow.__pdfBlinkTrace;
            if (!trace || trace.events.length > 2_000) {
                return;
            }
            for (const mutation of mutations) {
                const target = mutation.target instanceof HTMLElement ? mutation.target : null;
                const pageContainer = target?.closest?.('.page_container') as HTMLElement | null;
                const important = pageContainer
                    || Array.from(mutation.addedNodes).some(node => node instanceof HTMLElement && (
                        node.matches('.page_container, .pdf-page-skeleton, canvas')
                        || Boolean(node.querySelector?.('.page_container, .pdf-page-skeleton, canvas'))
                    ))
                    || Array.from(mutation.removedNodes).some(node => node instanceof HTMLElement && (
                        node.matches('.page_container, .pdf-page-skeleton, canvas')
                        || Boolean(node.querySelector?.('.page_container, .pdf-page-skeleton, canvas'))
                    ));
                if (!important) {
                    continue;
                }
                recordEvent('dom-mutation', {
                    type: mutation.type,
                    attributeName: mutation.attributeName,
                    targetClass: target?.className ?? null,
                    targetPage: pageContainer?.dataset.page ?? null,
                    added: mutation.addedNodes.length,
                    removed: mutation.removedNodes.length,
                });
            }
        });
        traceWindow.__pdfBlinkTraceObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: [
                'class',
                'style',
            ],
            childList: true,
            subtree: true,
        });

        function tick() {
            const trace = traceWindow.__pdfBlinkTrace;
            if (!traceWindow.__pdfBlinkTraceRunning || !trace) {
                return;
            }
            trace.samples.push(collectSample());
            window.requestAnimationFrame(tick);
        }

        traceWindow.__startPdfBlinkTrace = () => {
            traceWindow.__pdfBlinkTraceRunning = true;
            recordEvent('trace-start');
            window.requestAnimationFrame(tick);
        };
        traceWindow.__stopPdfBlinkTrace = () => {
            traceWindow.__pdfBlinkTraceRunning = false;
            recordEvent('trace-stop');
            traceWindow.__pdfBlinkTraceObserver?.disconnect();
            return traceWindow.__pdfBlinkTrace ?? null;
        };
    });
}

async function waitForWorkspaceReady(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
    timeoutMs = 60_000,
) {
    await page.waitForFunction(() => {
        type TWorkspaceExpose = {getToolbarSnapshot?: () => {
            hasPdf?: boolean;
            totalPages?: number;
            currentPage?: number;
        };};
        type TWorkspaceComponentElement = HTMLElement & {__vueParentComponent?: {
            exposed?: TWorkspaceExpose;
            parent?: TWorkspaceComponentElement['__vueParentComponent'];
        };};
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            let component = (element as TWorkspaceComponentElement).__vueParentComponent ?? null;
            while (component) {
                const snapshot = component.exposed?.getToolbarSnapshot?.();
                if (
                    snapshot?.hasPdf === true
                    && typeof snapshot.totalPages === 'number'
                    && snapshot.totalPages > 1
                    && typeof snapshot.currentPage === 'number'
                    && document.querySelector('#pdf-viewer')
                ) {
                    return true;
                }
                component = component.parent ?? null;
            }
        }
        return false;
    }, { timeout: timeoutMs });
}

async function recordTraceEvent(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
    kind: string,
    payload: unknown = {},
) {
    await page.evaluate(([
        eventKind,
        eventPayload,
    ]) => {
        const traceWindow = window as Window & {__recordPdfBlinkEvent?: (kind: string, payload?: unknown) => void;};
        traceWindow.__recordPdfBlinkEvent?.(eventKind as string, eventPayload);
    }, [
        kind,
        payload,
    ]);
}

async function configureFitHeightPagedMode(page: Awaited<ReturnType<typeof startElectronE2ESession>>['page']) {
    const configured = await page.evaluate(() => {
        type TWorkspaceExpose = {
            getToolbarSnapshot?: () => {continuousScroll?: boolean;};
            handleFitHeight?: () => void;
            handleToggleContinuousScroll?: () => void;
            handleViewModeSingle?: () => void;
        };
        type TWorkspaceComponentElement = HTMLElement & {__vueParentComponent?: {
            exposed?: TWorkspaceExpose;
            parent?: TWorkspaceComponentElement['__vueParentComponent'];
        };};
        function findWorkspaceExpose() {
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                let component = (element as TWorkspaceComponentElement).__vueParentComponent ?? null;
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
        throw new Error('Unable to configure fit-height paged mode');
    }
    await delay(500);
}

async function goToPageViaWorkspace(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
    pageNumber: number,
) {
    const navigated = await page.evaluate((targetPage: number) => {
        type TWorkspaceExpose = {
            handleGoToPage?: (page: number) => void;
            getToolbarSnapshot?: () => unknown;
        };
        type TWorkspaceComponentElement = HTMLElement & {__vueParentComponent?: {
            exposed?: TWorkspaceExpose;
            parent?: TWorkspaceComponentElement['__vueParentComponent'];
        };};
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            let component = (element as TWorkspaceComponentElement).__vueParentComponent ?? null;
            while (component) {
                const exposed = component.exposed;
                if (
                    typeof exposed?.getToolbarSnapshot === 'function'
                    && typeof exposed.handleGoToPage === 'function'
                ) {
                    exposed.handleGoToPage(targetPage);
                    return true;
                }
                component = component.parent ?? null;
            }
        }
        return false;
    }, pageNumber);

    if (!navigated) {
        throw new Error(`Unable to navigate workspace to page ${pageNumber}`);
    }
}

async function waitForToolbarPage(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
    pageNumber: number,
) {
    await page.waitForFunction((targetPage: number) => {
        type TWorkspaceExpose = {getToolbarSnapshot?: () => {currentPage?: number;};};
        type TWorkspaceComponentElement = HTMLElement & {__vueParentComponent?: {
            exposed?: TWorkspaceExpose;
            parent?: TWorkspaceComponentElement['__vueParentComponent'];
        };};
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            let component = (element as TWorkspaceComponentElement).__vueParentComponent ?? null;
            while (component) {
                const snapshot = component.exposed?.getToolbarSnapshot?.();
                if (snapshot?.currentPage === targetPage) {
                    return true;
                }
                component = component.parent ?? null;
            }
        }
        return false;
    }, { timeout: 20_000 }, pageNumber);
}

async function waitForPageCanvas(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
    pageNumber: number,
) {
    await page.waitForFunction((targetPage: number) => {
        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPage}"]`);
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && container.querySelector('.page_canvas canvas'),
        );
    }, { timeout: 30_000 }, pageNumber);
}

async function clickNextPage(page: Awaited<ReturnType<typeof startElectronE2ESession>>['page']) {
    await page.waitForFunction(() => {
        const isVisibleEnabled = (button: HTMLButtonElement) => {
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return !button.disabled
                && button.getAttribute('aria-disabled') !== 'true'
                && rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .some(candidate => {
                const label = candidate.getAttribute('aria-label') ?? '';
                return (label === 'Next Page' || label.startsWith('Next Page ('))
                    && isVisibleEnabled(candidate);
            });
    }, { timeout: 30_000 });

    const clicked = await page.evaluate(() => {
        const isVisibleEnabled = (button: HTMLButtonElement) => {
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return !button.disabled
                && button.getAttribute('aria-disabled') !== 'true'
                && rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .find(candidate => {
                const label = candidate.getAttribute('aria-label') ?? '';
                return (label === 'Next Page' || label.startsWith('Next Page ('))
                    && isVisibleEnabled(candidate);
            });
        button?.click();
        return {
            clicked: Boolean(button),
            label: button?.getAttribute('aria-label') ?? null,
            pageText: Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .filter(element => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden';
                })
                .map(element => element.textContent?.trim() ?? ''),
        };
    });

    if (!clicked.clicked) {
        throw new Error(`Unable to click Next Page: ${JSON.stringify(clicked)}`);
    }

    return clicked;
}

async function collectPdfNavLog(page: Awaited<ReturnType<typeof startElectronE2ESession>>['page']) {
    return page.evaluate(() => {
        const logWindow = window as Window & { __getPdfNavLog?: () => unknown[]; };
        return logWindow.__getPdfNavLog?.() ?? [];
    });
}

async function collectPdfRenderTrace(page: Awaited<ReturnType<typeof startElectronE2ESession>>['page']) {
    return page.evaluate(() => {
        const traceWindow = window as Window & { __getPdfRenderTrace?: () => unknown[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

function uniqueNumbers(values: unknown[]) {
    const result: number[] = [];
    for (const value of values) {
        const numeric = typeof value === 'number' ? value : Number.NaN;
        if (Number.isFinite(numeric) && result.at(-1) !== numeric) {
            result.push(numeric);
        }
    }
    return result;
}

export function analyzeTraceFrames(samples: Array<Record<string, unknown>>): IFrameAnalysisSummary {
    let canvasObservedAtMs: number | null = null;
    let firstSkeletonAfterCanvasAtMs: number | null = null;
    const skeletonAfterCanvasPages = new Set<number>();

    for (const sample of samples) {
        const atMs = typeof sample.atMs === 'number' ? sample.atMs : 0;
        const canvasPages = Array.isArray(sample.canvasPages) ? sample.canvasPages : [];
        const skeletonPages = Array.isArray(sample.skeletonPages) ? sample.skeletonPages : [];

        if (canvasObservedAtMs !== null && skeletonPages.length > 0) {
            firstSkeletonAfterCanvasAtMs ??= atMs;
            for (const page of skeletonPages) {
                if (typeof page === 'number' && Number.isFinite(page)) {
                    skeletonAfterCanvasPages.add(page);
                }
            }
        }

        if (canvasObservedAtMs === null && canvasPages.length > 0) {
            canvasObservedAtMs = atMs;
        }
    }

    return {
        canvasObservedAtMs,
        firstSkeletonAfterCanvasAtMs,
        skeletonAfterCanvasObserved: firstSkeletonAfterCanvasAtMs !== null,
        skeletonAfterCanvasPages: Array.from(skeletonAfterCanvasPages),
    };
}

export function summarizeTrace(payload: {
    trace: {samples?: Array<Record<string, unknown>>;};
    renderTrace: Array<{
        event?: string;
        payload?: Record<string, unknown>;
    }>;
}): ITraceSummary {
    const samples = payload.trace.samples ?? [];
    const blankSamples = samples.filter(sample => Array.isArray(sample.blankVisiblePages) && sample.blankVisiblePages.length > 0);
    const skeletonSamples = samples.filter(sample => Array.isArray(sample.skeletonPages) && sample.skeletonPages.length > 0);
    let maxBlankRunMs = 0;
    let blankRunStartedAt: number | null = null;
    let lastBlankAt: number | null = null;
    for (const sample of samples) {
        const atMs = typeof sample.atMs === 'number' ? sample.atMs : 0;
        const isBlank = Array.isArray(sample.blankVisiblePages) && sample.blankVisiblePages.length > 0;
        if (isBlank) {
            blankRunStartedAt ??= atMs;
            lastBlankAt = atMs;
        } else if (blankRunStartedAt !== null && lastBlankAt !== null) {
            maxBlankRunMs = Math.max(maxBlankRunMs, lastBlankAt - blankRunStartedAt);
            blankRunStartedAt = null;
            lastBlankAt = null;
        }
    }
    if (blankRunStartedAt !== null && lastBlankAt !== null) {
        maxBlankRunMs = Math.max(maxBlankRunMs, lastBlankAt - blankRunStartedAt);
    }

    const toolbarPages = uniqueNumbers(samples.map(sample => {
        const snapshot = sample.toolbarSnapshot as {currentPage?: unknown;} | null | undefined;
        return snapshot?.currentPage;
    }));
    const workspaceGoToPages = uniqueNumbers(payload.renderTrace
        .filter(entry => entry.event === 'workspace-go-to-page')
        .map(entry => entry.payload?.targetPage));
    const pagedTargets = uniqueNumbers(payload.renderTrace
        .filter(entry => entry.event === 'single-page-set-paged-target')
        .map(entry => entry.payload?.targetPage));

    return {
        blankSampleCount: blankSamples.length,
        frameAnalysis: analyzeTraceFrames(samples),
        firstBlankSample: blankSamples[0] ?? null,
        maxBlankRunMs,
        skeletonSampleCount: skeletonSamples.length,
        toolbarPages,
        workspaceGoToPages,
        pagedTargets,
    };
}

function createVideoCapturePayload(videoCapture: IDiagnosticFrameCaptureResult | null) {
    if (!videoCapture) {
        return {
            enabled: false,
            artifactPaths: null,
            capture: null,
        };
    }

    return {
        enabled: true,
        artifactPaths: {
            contactSheet: videoCapture.contactSheetPath,
            framesDir: videoCapture.framesDir,
            mp4: videoCapture.mp4Path,
            outDir: videoCapture.outDir,
        },
        capture: videoCapture,
    };
}

async function main() {
    const options = readOptions();
    const outPath = resolve(process.cwd(), options.out);
    const session = await startElectronE2ESession(`pdf-blink-trace-${Date.now()}`);
    try {
        await openPdfInApp(session.page, options.pdf, 120_000);
        await enablePdfDiagnostics(session.page);
        await installBlinkSampler(session.page);
        await goToPageViaWorkspace(session.page, options.startPage);
        await waitForToolbarPage(session.page, options.startPage);
        await configureFitHeightPagedMode(session.page);
        await waitForPageCanvas(session.page, options.startPage);
        await delay(500);

        const videoRecorder = options.video
            ? await startDiagnosticFrameCapture(session.page, {
                fps: options.videoFps,
                outDir: resolveVideoDirectory(options),
            })
            : null;
        await session.page.evaluate(() => {
            const traceWindow = window as Window & { __startPdfBlinkTrace?: () => void; };
            traceWindow.__startPdfBlinkTrace?.();
        });
        await recordTraceEvent(session.page, 'scenario-start', options);
        for (let index = 0; index < options.clicks; index += 1) {
            await recordTraceEvent(session.page, 'before-next-click', { index });
            const clickResult = await clickNextPage(session.page);
            await recordTraceEvent(session.page, 'after-next-click', {
                index,
                clickResult,
            });
            await delay(options.clickDelayMs);
        }
        await delay(options.settleMs);
        const trace = await session.page.evaluate(() => {
            const traceWindow = window as Window & { __stopPdfBlinkTrace?: () => unknown; };
            return traceWindow.__stopPdfBlinkTrace?.() ?? null;
        });
        const videoCapture = videoRecorder ? await videoRecorder.stop() : null;
        const navLog = await collectPdfNavLog(session.page);
        const renderTrace = await collectPdfRenderTrace(session.page) as Array<{
            event?: string;
            payload?: Record<string, unknown>;
        }>;
        const payload = {
            createdAt: new Date().toISOString(),
            options,
            trace,
            navLog,
            renderTrace,
            video: createVideoCapturePayload(videoCapture),
            summary: summarizeTrace({
                trace: trace ?? {},
                renderTrace,
            }),
        };
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
        console.log(`Wrote ${outPath}`);
        console.log(JSON.stringify(payload.summary, null, 2));
    } finally {
        await session.stop();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
