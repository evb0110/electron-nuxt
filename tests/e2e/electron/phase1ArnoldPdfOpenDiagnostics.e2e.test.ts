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
import type {
    ConsoleMessage,
    Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/sessionHarness';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';

const TARGET_PDF_PATH = '.devkit/manual-pdf-fixtures/Arnold - 5. Grammatik _best_p_oo.pdf';
const DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'arnold-pdf-open-diagnostics.json',
);
const CONSOLE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'arnold-pdf-open-console.log',
);
const CONSOLE_MESSAGE_LIMIT = 2_000;
const SAMPLE_OFFSETS_MS = [
    0,
    250,
    500,
    1_000,
    2_000,
    3_000,
    4_000,
    4_500,
    5_000,
    7_000,
    10_000,
    15_000,
    20_000,
    25_000,
    30_000,
];

type TPdfNavLogEntry = {
    message: string;
    args: unknown[];
    loggedAtMs: number;
};

type TPdfRenderTraceEntry = {
    event: string;
    payload: Record<string, unknown>;
};

interface IConsoleLogEntry {
    receivedAtMs: number;
    type: string;
    text: string;
    location: {
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
    };
    args: unknown[];
}

interface IConsoleCollector {
    entries: IConsoleLogEntry[];
    dispose: () => void;
}

interface IOpenTriggerResult {
    status: 'resolved' | 'failed';
    opened: boolean;
    elapsedMs: number;
    attempts: IOpenAttempt[];
    error?: string;
}

interface IOpenAttempt {
    startedAtMs: number;
    finishedAtMs?: number;
    opened?: boolean;
    error?: string;
}

interface IOpenProgress {
    status: 'pending' | 'retrying' | 'resolved' | 'failed';
    attempts: IOpenAttempt[];
    startedAtMs: number;
    finishedAtMs?: number;
    error?: string;
}

interface IArnoldSnapshot {
    label: string;
    sampledAtMs: number;
    url: string;
    openResult: unknown;
    counts: Record<string, number>;
    workspace: {
        toolbarSnapshot: unknown;
        loadingText: string | null;
        hostClassName: string | null;
        hostRect: unknown;
        openingSkeletonRect: unknown;
    };
    viewer: {
        className: string | null;
        rect: unknown;
        scrollTop: number | null;
        scrollHeight: number | null;
        clientHeight: number | null;
        computed: Record<string, string> | null;
    };
    pages: unknown[];
}

function safeJson(value: unknown) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

async function serializeConsoleMessage(message: ConsoleMessage, startedAtMs: number): Promise<IConsoleLogEntry> {
    const args = await Promise.all(message.args().slice(0, 8).map(async (handle) => {
        try {
            return await handle.jsonValue();
        } catch (error) {
            return {unserializable: error instanceof Error ? error.message : String(error)};
        }
    }));
    const location = message.location();
    const serializedLocation: IConsoleLogEntry['location'] = {};
    if (location.url !== undefined) {
        serializedLocation.url = location.url;
    }
    if (location.lineNumber !== undefined) {
        serializedLocation.lineNumber = location.lineNumber;
    }
    if (location.columnNumber !== undefined) {
        serializedLocation.columnNumber = location.columnNumber;
    }

    return {
        receivedAtMs: Date.now() - startedAtMs,
        type: message.type(),
        text: message.text(),
        location: serializedLocation,
        args,
    };
}

function installConsoleCollector(page: Page): IConsoleCollector {
    const startedAtMs = Date.now();
    const entries: IConsoleLogEntry[] = [];
    const pushEntry = (entry: IConsoleLogEntry) => {
        entries.push(entry);
        if (entries.length > CONSOLE_MESSAGE_LIMIT) {
            entries.splice(0, entries.length - CONSOLE_MESSAGE_LIMIT);
        }
    };
    const consoleHandler = (message: ConsoleMessage) => {
        void serializeConsoleMessage(message, startedAtMs)
            .then(pushEntry)
            .catch(error => pushEntry({
                receivedAtMs: Date.now() - startedAtMs,
                type: 'console-serialization-error',
                text: error instanceof Error ? error.message : String(error),
                location: {},
                args: [],
            }));
    };
    const pageErrorHandler = (event: unknown) => {
        const error = event instanceof Error ? event : new Error(String(event));
        pushEntry({
            receivedAtMs: Date.now() - startedAtMs,
            type: 'pageerror',
            text: error.message,
            location: {},
            args: [{
                name: error.name,
                stack: error.stack,
            }],
        });
    };

    page.on('console', consoleHandler);
    page.on('pageerror', pageErrorHandler);

    return {
        entries,
        dispose: () => {
            page.off('console', consoleHandler);
            page.off('pageerror', pageErrorHandler);
        },
    };
}

function formatConsoleEntry(entry: IConsoleLogEntry) {
    const location = entry.location.url
        ? ` ${entry.location.url}:${entry.location.lineNumber ?? 0}:${entry.location.columnNumber ?? 0}`
        : '';
    const args = entry.args.length > 0 ? ` ${safeJson(entry.args)}` : '';
    return `[${entry.receivedAtMs}ms] ${entry.type}${location} ${entry.text}${args}`;
}

function writeDiagnosticArtifacts(payload: unknown, consoleEntries: IConsoleLogEntry[]) {
    mkdirSync(dirname(DIAGNOSTIC_OUTPUT_PATH), { recursive: true });
    writeFileSync(DIAGNOSTIC_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(CONSOLE_OUTPUT_PATH, `${consoleEntries.map(formatConsoleEntry).join('\n')}\n`);
}

async function enableDiagnosticLogging(page: Page) {
    await evaluateInPage(page, () => {
        localStorage.setItem('evb-viewer:pdf-nav-log', '1');
        localStorage.setItem('evb-viewer:pdf-nav-log-console', '1');
        localStorage.setItem('evb-viewer:pdf-render-trace', '1');
        localStorage.setItem('evb-viewer:pdf-render-trace-console', '1');
        const diagnosticWindow = window as Window & {
            __diagnosticWarnAsWarn?: boolean;
            __pdfNavLog?: boolean;
            __pdfNavLogConsole?: boolean;
            __clearPdfNavLog?: () => void;
            __pdfRenderTrace?: boolean;
            __pdfRenderTraceConsole?: boolean;
            __clearPdfRenderTrace?: () => void;
        };
        diagnosticWindow.__diagnosticWarnAsWarn = true;
        diagnosticWindow.__pdfNavLog = true;
        diagnosticWindow.__pdfNavLogConsole = true;
        diagnosticWindow.__clearPdfNavLog?.();
        diagnosticWindow.__pdfRenderTrace = true;
        diagnosticWindow.__pdfRenderTraceConsole = true;
        diagnosticWindow.__clearPdfRenderTrace?.();
    });
}

async function waitForStableWorkspace(page: Page) {
    await page.waitForFunction(() => {
        const diagnosticWindow = window as Window & {__openFileDirect?: unknown;};
        const host = document.querySelector<HTMLElement>('.workspace-host');
        const hostRect = host?.getBoundingClientRect();
        return typeof diagnosticWindow.__openFileDirect === 'function'
            && Boolean(hostRect && hostRect.width > 100 && hostRect.height > 100);
    }, { timeout: 30_000 });
    await delay(1_000);
}

function isExecutionContextReset(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}

async function openPathDirectOnce(page: Page, pdfPath: string) {
    return page.evaluate(async (path: string) => {
        const diagnosticWindow = window as Window & {
            __allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;
            __openFileDirect?: (value: string) => Promise<boolean>;
            electronAPI?: {documents?: {recentFiles?: {add?: (value: string) => Promise<void>;};};};
        };

        const automationGrant = diagnosticWindow.__allowRendererFileOpenForAutomation;
        if (typeof automationGrant === 'function') {
            await automationGrant(path);
        }

        try {
            await diagnosticWindow.electronAPI?.documents?.recentFiles?.add?.(path);
        } catch {
            // The direct-open path is what this diagnostic needs; recent-file seeding is best effort.
        }

        const openFileDirect = diagnosticWindow.__openFileDirect;
        if (typeof openFileDirect !== 'function') {
            throw new Error('window.__openFileDirect is not available');
        }

        return openFileDirect(path);
    }, pdfPath);
}

async function openPathDirectWithRetry(
    page: Page,
    pdfPath: string,
    progress: IOpenProgress,
): Promise<IOpenTriggerResult> {
    const timeoutMs = 45_000;
    const startedAtMs = Date.now();
    let lastError: string | undefined;

    while (Date.now() - startedAtMs < timeoutMs) {
        const attempt: IOpenAttempt = {startedAtMs: Date.now() - startedAtMs};
        progress.attempts.push(attempt);
        try {
            const opened = await openPathDirectOnce(page, pdfPath);
            attempt.finishedAtMs = Date.now() - startedAtMs;
            attempt.opened = Boolean(opened);
            progress.status = 'resolved';
            progress.finishedAtMs = Date.now();
            return {
                status: 'resolved',
                opened: Boolean(opened),
                elapsedMs: Date.now() - startedAtMs,
                attempts: progress.attempts,
            };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            attempt.finishedAtMs = Date.now() - startedAtMs;
            attempt.error = lastError;
            progress.status = 'retrying';
            progress.error = lastError;
            if (!isExecutionContextReset(error)) {
                break;
            }
            await delay(500);
        }
    }

    progress.status = 'failed';
    progress.finishedAtMs = Date.now();
    if (lastError !== undefined) {
        progress.error = lastError;
    }
    const result: IOpenTriggerResult = {
        status: 'failed',
        opened: false,
        elapsedMs: Date.now() - startedAtMs,
        attempts: progress.attempts,
    };
    if (lastError !== undefined) {
        result.error = lastError;
    }
    return result;
}

async function collectPdfNavLog(page: Page) {
    return evaluateInPage(page, () => {
        const logWindow = window as Window & { __getPdfNavLog?: () => TPdfNavLogEntry[]; };
        return logWindow.__getPdfNavLog?.() ?? [];
    });
}

async function collectPdfRenderTrace(page: Page) {
    return evaluateInPage(page, () => {
        const traceWindow = window as Window & { __getPdfRenderTrace?: () => TPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

async function collectOpenSnapshot(page: Page, label: string, startedAtMs: number): Promise<IArnoldSnapshot> {
    return evaluateInPage(page, (snapshotLabel: string, nodeStartedAtMs: number): IArnoldSnapshot => {
        const diagnosticWindow = window as Window & {__arnoldDiagnosticOpenResult?: unknown;};

        const rectSnapshot = (element: Element | null) => {
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                top: Math.round(rect.top),
                right: Math.round(rect.right),
                bottom: Math.round(rect.bottom),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            };
        };

        const styleSnapshot = (element: Element | null) => {
            if (!element) {
                return null;
            }
            const style = window.getComputedStyle(element);
            return {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                overflow: style.overflow,
                overflowY: style.overflowY,
                position: style.position,
            };
        };

        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };

        const sampleCanvas = (canvas: HTMLCanvasElement | null) => {
            if (!canvas) {
                return null;
            }

            const rect = canvas.getBoundingClientRect();
            const result = {
                width: canvas.width,
                height: canvas.height,
                cssWidth: Math.round(rect.width),
                cssHeight: Math.round(rect.height),
                sampleCount: 0,
                nonWhitePixelCount: 0,
                whitePixelCount: 0,
                transparentPixelCount: 0,
                stride: 0,
                likelyBlankWhite: false,
                error: null as string | null,
            };

            try {
                const context = canvas.getContext('2d');
                if (!context || canvas.width <= 0 || canvas.height <= 0) {
                    result.error = 'canvas context unavailable or empty';
                    return result;
                }

                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                const targetSamples = 2_500;
                const stride = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / targetSamples)));
                result.stride = stride;
                for (let y = 0; y < canvas.height; y += stride) {
                    for (let x = 0; x < canvas.width; x += stride) {
                        const offset = ((y * canvas.width) + x) * 4;
                        const red = pixels[offset] ?? 0;
                        const green = pixels[offset + 1] ?? 0;
                        const blue = pixels[offset + 2] ?? 0;
                        const alpha = pixels[offset + 3] ?? 0;
                        result.sampleCount += 1;
                        if (alpha === 0) {
                            result.transparentPixelCount += 1;
                        } else if (red >= 248 && green >= 248 && blue >= 248) {
                            result.whitePixelCount += 1;
                        } else {
                            result.nonWhitePixelCount += 1;
                        }
                    }
                }
                result.likelyBlankWhite = result.sampleCount > 0
                    && result.nonWhitePixelCount === 0
                    && result.transparentPixelCount === 0;
            } catch (error) {
                result.error = error instanceof Error ? error.message : String(error);
            }

            return result;
        };

        const findWorkspaceExpose = () => {
            const hosts = [
                ...Array.from(document.querySelectorAll<HTMLElement>('.editor-pane.is-active .workspace-host')),
                ...Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')),
            ];
            for (const element of hosts) {
                let component = (element as HTMLElement & {__vueParentComponent?: {
                    exposed?: {getToolbarSnapshot?: () => unknown;};
                    parent?: {
                        exposed?: {getToolbarSnapshot?: () => unknown;};
                        parent?: unknown;
                    } | null;
                };}).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (typeof exposed?.getToolbarSnapshot === 'function') {
                        return exposed;
                    }
                    component = component.parent as typeof component;
                }
            }
            return null;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
            ?? Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisibleElement)
            ?? null;
        const visibleViewers = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer')).filter(isVisibleElement);
        const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
        const viewer = activeViewer && isVisibleElement(activeViewer)
            ? activeViewer
            : (visibleViewers[0] ?? null);
        const pageContainers = Array.from(viewer?.querySelectorAll<HTMLElement>('.page_container') ?? []);
        const visiblePages = pageContainers.filter((container) => {
            const rect = container.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
        });
        const firstPage = pageContainers[0] ?? null;
        const pagesToSample = Array.from(new Set([
            firstPage,
            ...visiblePages,
        ].filter((element): element is HTMLElement => Boolean(element)))).slice(0, 5);
        const workspaceExpose = findWorkspaceExpose();

        return {
            label: snapshotLabel,
            sampledAtMs: Date.now() - nodeStartedAtMs,
            url: window.location.href,
            openResult: diagnosticWindow.__arnoldDiagnosticOpenResult ?? null,
            counts: {
                workspaceHosts: document.querySelectorAll('.workspace-host').length,
                visibleViewers: visibleViewers.length,
                pageContainers: pageContainers.length,
                renderedPages: viewer?.querySelectorAll('.page_container--rendered').length ?? 0,
                pageSkeletons: viewer?.querySelectorAll('.pdf-page-skeleton').length ?? 0,
                canvases: viewer?.querySelectorAll('.page_canvas canvas').length ?? 0,
                textSpans: viewer?.querySelectorAll('.text-layer span, .textLayer span').length ?? 0,
                loadingStates: document.querySelectorAll('.pdf-loading, .pdf-loading-overlay, [data-loading="true"]').length,
                errorStates: document.querySelectorAll('.pdf-error, .viewer-error, [data-error="true"]').length,
            },
            workspace: {
                toolbarSnapshot: workspaceExpose?.getToolbarSnapshot?.() ?? null,
                loadingText: document.querySelector<HTMLElement>('.document-loading, .pdf-loading, .pdf-loading-overlay')?.textContent?.trim() ?? null,
                hostClassName: activeHost?.className ?? null,
                hostRect: rectSnapshot(activeHost),
                openingSkeletonRect: rectSnapshot(document.querySelector('.workspace-host__opening-skeleton')),
            },
            viewer: {
                className: viewer?.className ?? null,
                rect: rectSnapshot(viewer),
                scrollTop: viewer?.scrollTop ?? null,
                scrollHeight: viewer?.scrollHeight ?? null,
                clientHeight: viewer?.clientHeight ?? null,
                computed: styleSnapshot(viewer),
            },
            pages: pagesToSample.map((pageContainer) => {
                const canvas = pageContainer.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                const skeleton = pageContainer.querySelector<HTMLElement>('.pdf-page-skeleton');
                const pageCanvas = pageContainer.querySelector<HTMLElement>('.page_canvas');
                return {
                    page: Number(pageContainer.dataset.page ?? pageContainer.getAttribute('data-page-number') ?? 0),
                    className: pageContainer.className,
                    rect: rectSnapshot(pageContainer),
                    computed: styleSnapshot(pageContainer),
                    hasRenderedClass: pageContainer.classList.contains('page_container--rendered'),
                    skeletonRect: rectSnapshot(skeleton),
                    skeletonComputed: styleSnapshot(skeleton),
                    pageCanvasRect: rectSnapshot(pageCanvas),
                    pageCanvasComputed: styleSnapshot(pageCanvas),
                    canvasCount: pageContainer.querySelectorAll('.page_canvas canvas').length,
                    textSpanCount: pageContainer.querySelectorAll('.text-layer span, .textLayer span').length,
                    canvas: sampleCanvas(canvas),
                };
            }),
        };
    }, label, startedAtMs);
}

async function collectTimedSnapshots(page: Page, startedAtMs: number) {
    const snapshots: IArnoldSnapshot[] = [];
    for (const offsetMs of SAMPLE_OFFSETS_MS) {
        const waitMs = Math.max(0, startedAtMs + offsetMs - Date.now());
        if (waitMs > 0) {
            await delay(waitMs);
        }
        snapshots.push(await collectOpenSnapshot(page, `open+${offsetMs}ms`, startedAtMs));
    }
    return snapshots;
}

async function scrollActiveViewer(page: Page) {
    return evaluateInPage(page, () => {
        const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
        const visibleViewer = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer')).find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        });
        const scroller = activeViewer ?? visibleViewer ?? document.scrollingElement;
        if (!scroller) {
            return {
                scrolled: false,
                reason: 'no scroll target',
            };
        }

        const beforeScrollTop = scroller.scrollTop;
        scroller.scrollTop = beforeScrollTop + 96;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        window.dispatchEvent(new Event('scroll'));
        return {
            scrolled: true,
            target: scroller === document.scrollingElement ? 'document' : 'pdf-viewer',
            beforeScrollTop,
            afterScrollTop: scroller.scrollTop,
        };
    });
}

const describeArnoldPdf = existsSync(TARGET_PDF_PATH) ? describe : describe.skip;

describeArnoldPdf('Electron E2E - Arnold PDF open diagnostics', () => {
    let session: IElectronE2ESession | null = null;
    let consoleCollector: IConsoleCollector | null = null;

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-arnold-pdf-open-${Date.now()}`);
        consoleCollector = installConsoleCollector(session.page);
        await enableDiagnosticLogging(session.page);
    }, 120_000);

    afterAll(async () => {
        consoleCollector?.dispose();
        await session?.stop();
    });

    it('dumps open lifecycle and visual state before and after scroll', async () => {
        if (!session || !consoleCollector) {
            throw new Error('Arnold diagnostic session was not initialized');
        }

        const page = session.page;
        await waitForStableWorkspace(page);
        const diagnosticStartedAtMs = Date.now();
        const openProgress: IOpenProgress = {
            status: 'pending',
            attempts: [],
            startedAtMs: diagnosticStartedAtMs,
        };
        const openPromise = openPathDirectWithRetry(page, TARGET_PDF_PATH, openProgress);
        const snapshots = await collectTimedSnapshots(page, diagnosticStartedAtMs);
        const triggerResult = await openPromise;
        const beforeScroll = await collectOpenSnapshot(page, 'before-scroll', diagnosticStartedAtMs);
        const scrollResult = await scrollActiveViewer(page);
        await delay(1_000);
        const afterScroll = await collectOpenSnapshot(page, 'after-scroll+1000ms', diagnosticStartedAtMs);
        const navLog = await collectPdfNavLog(page);
        const renderTrace = await collectPdfRenderTrace(page);
        const consoleEntries = [...consoleCollector.entries];

        writeDiagnosticArtifacts({
            pdfPath: TARGET_PDF_PATH,
            capturedAt: new Date().toISOString(),
            triggerResult,
            openProgress,
            snapshots,
            beforeScroll,
            scrollResult,
            afterScroll,
            navLog,
            renderTrace,
            consoleEntries,
            recentOpenWarnings: consoleEntries.filter(entry => entry.text.includes('Document open visual settle timed out')),
            renderTracePageOne: renderTrace.filter(entry => {
                const pageNumber = entry.payload.pageNumber ?? entry.payload.page;
                return pageNumber === 1;
            }),
        }, consoleEntries);

        expect(triggerResult.status).toBe('resolved');
        expect(triggerResult.opened).toBe(true);
        expect(existsSync(DIAGNOSTIC_OUTPUT_PATH)).toBe(true);
        expect(existsSync(CONSOLE_OUTPUT_PATH)).toBe(true);
    }, 90_000);
});
