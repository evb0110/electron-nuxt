import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import {
    COMMAND_EXECUTION_TIMEOUT_MS,
    OPEN_PDF_READY_TIMEOUT_MS,
    OPEN_PDF_TRIGGER_TIMEOUT_MS,
    screenshotDirPath,
    type IDevtoolsEvent,
    type ISessionState,
} from './shared';

const DEFAULT_CONSOLE_LIMIT = 50;
const DEFAULT_DEVTOOLS_LIMIT = 120;
const DEFAULT_SCREENSHOT_INTERVAL_MS = 1000;
const DEFAULT_SCREENSHOT_COUNT = 5;

function sanitizeSnapshotName(name: string) {
    return name
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100) || `screenshot-${Date.now()}`;
}

function parsePositiveInt(value: unknown, fallback: number, max: number) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parseNonNegativeInt(value: unknown, fallback: number, max: number) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

function parseBooleanArg(value: unknown, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value !== 'string') {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if ([
        '1',
        'true',
        'yes',
        'y',
        'on',
        'full',
    ].includes(normalized)) {
        return true;
    }
    if ([
        '0',
        'false',
        'no',
        'n',
        'off',
    ].includes(normalized)) {
        return false;
    }
    return fallback;
}

function normalizeEventLimit(value: unknown, fallback: number) {
    return parsePositiveInt(value, fallback, 2000);
}

function getDevtoolsSummary(events: IDevtoolsEvent[]) {
    return events.reduce((acc, event) => {
        acc[event.kind] = (acc[event.kind] ?? 0) + 1;
        return acc;
    }, {} as Record<string, number>);
}

export function createCommandHandler(getSessionState: () => ISessionState | null) {
    return async function handleCommand(command: string, args: unknown[]): Promise<unknown> {
        const sessionState = getSessionState();
        if (!sessionState) {
            throw new Error('Session not initialized');
        }

        const {
            page,
            consoleMessages,
            devtoolsEvents,
        } = sessionState;
        const ssDirPath = screenshotDirPath();
        const takeScreenshot = async (name: string, fullPage = false) => {
            mkdirSync(ssDirPath, { recursive: true });
            const filepath = join(ssDirPath, `${sanitizeSnapshotName(name)}.png`);
            await page.screenshot({ path: filepath, fullPage });
            return filepath;
        };

        switch (command) {
            case 'ping':
                return { status: 'ok', uptime: process.uptime() };

            case 'screenshot': {
                const name = (args[0] as string) ?? `screenshot-${Date.now()}`;
                const fullPage = parseBooleanArg(args[1]);
                const filepath = await takeScreenshot(name, fullPage);
                return {
                    screenshot: filepath,
                    fullPage,
                };
            }

            case 'screenshots': {
                const baseName = sanitizeSnapshotName((args[0] as string) ?? `timelapse-${Date.now()}`);
                const count = parsePositiveInt(args[1], DEFAULT_SCREENSHOT_COUNT, 240);
                const intervalMs = parseNonNegativeInt(args[2], DEFAULT_SCREENSHOT_INTERVAL_MS, 60_000);
                const fullPage = parseBooleanArg(args[3]);

                const captures: Array<{ index: number; path: string; timestamp: number }> = [];
                for (let index = 0; index < count; index += 1) {
                    const ordinal = String(index + 1).padStart(3, '0');
                    const filepath = await takeScreenshot(`${baseName}-${ordinal}`, fullPage);
                    captures.push({
                        index: index + 1,
                        path: filepath,
                        timestamp: Date.now(),
                    });
                    if (index < count - 1 && intervalMs > 0) {
                        await delay(intervalMs);
                    }
                }

                return {
                    captures,
                    count,
                    intervalMs,
                    fullPage,
                };
            }

            case 'console': {
                const level = (args[0] as string) ?? 'all';
                const limit = normalizeEventLimit(args[1], DEFAULT_CONSOLE_LIMIT);
                const filtered = level === 'all'
                    ? consoleMessages
                    : consoleMessages.filter((message) => message.type === level);
                return {
                    level,
                    limit,
                    messages: filtered.slice(-limit),
                };
            }

            case 'devtools': {
                const section = ((args[0] as string) ?? 'summary').toLowerCase();
                const limit = normalizeEventLimit(args[1], DEFAULT_DEVTOOLS_LIMIT);
                const events = devtoolsEvents.slice(-limit);

                if (section === 'summary') {
                    return {
                        section,
                        limit,
                        totalEvents: devtoolsEvents.length,
                        recentEvents: events,
                        counts: getDevtoolsSummary(devtoolsEvents),
                    };
                }

                if (section === 'console') {
                    return {
                        section,
                        limit,
                        events: events.filter(event => event.kind === 'console'),
                    };
                }

                if (section === 'network') {
                    return {
                        section,
                        limit,
                        events: events.filter(event => event.kind === 'request' || event.kind === 'response' || event.kind === 'requestfailed'),
                    };
                }

                if (section === 'errors') {
                    return {
                        section,
                        limit,
                        events: events.filter((event) => {
                            if (event.kind === 'error' || event.kind === 'pageerror' || event.kind === 'requestfailed') {
                                return true;
                            }
                            if (event.kind === 'console') {
                                return event.level === 'error' || event.level === 'warning' || event.level === 'warn';
                            }
                            if (event.kind === 'response') {
                                return typeof event.status === 'number' && event.status >= 400;
                            }
                            return false;
                        }),
                    };
                }

                if (section === 'metrics') {
                    const metrics = await page.metrics();
                    return {
                        section,
                        metrics,
                        viewport: page.viewport(),
                        url: page.url(),
                    };
                }

                if (section === 'all') {
                    const metrics = await page.metrics();
                    return {
                        section,
                        limit,
                        events,
                        counts: getDevtoolsSummary(devtoolsEvents),
                        metrics,
                        viewport: page.viewport(),
                        url: page.url(),
                    };
                }

                throw new Error('Unknown devtools section. Use summary|console|network|errors|metrics|all');
            }

            case 'run': {
                const code = args[0] as string;
                if (!code) {
                    throw new Error('No code provided');
                }

                const screenshotFn = async (name: string) => {
                    return await takeScreenshot(name, false);
                };
                const sleepFn = async (ms: number) => {
                    const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
                    await delay(duration);
                };

                const asyncFn = new Function(
                    'page', 'screenshot', 'sleep', 'wait',
                    `return (async () => { ${code} })()`,
                );

                return await Promise.race([
                    asyncFn(page, screenshotFn, sleepFn, sleepFn),
                    delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
                        throw new Error(`run command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
                    }),
                ]);
            }

            case 'eval': {
                const code = args[0] as string;
                if (!code) {
                    throw new Error('No code provided');
                }
                return await Promise.race([
                    page.evaluate(code),
                    delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
                        throw new Error(`eval command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
                    }),
                ]);
            }

            case 'click': {
                const selector = args[0] as string;
                if (!selector) {
                    throw new Error('No selector provided');
                }
                const timeoutMs = parsePositiveInt(args[1], 8_000, 120_000);
                const targetInfo = await page.evaluate((sel: string) => {
                    const el = document.querySelector(sel) as HTMLElement | null;
                    if (!el) {
                        return null;
                    }
                    const className = typeof el.className === 'string'
                        ? el.className
                        : ((el.className as SVGAnimatedString | undefined)?.baseVal ?? '');
                    const rect = el.getBoundingClientRect();
                    return {
                        tagName: el.tagName.toLowerCase(),
                        id: el.id || null,
                        className: className || null,
                        text: (el.textContent ?? '').trim().slice(0, 200),
                        rect: {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height,
                        },
                    };
                }, selector);

                if (!targetInfo) {
                    throw new Error(`Selector not found: ${selector}`);
                }

                await page.evaluate(() => {
                    const key = '__electronRunLastClickEvent';
                    (window as any)[key] = null;
                    const previousListener = (window as any).__electronRunClickCaptureListener as EventListener | undefined;
                    if (previousListener) {
                        window.removeEventListener('click', previousListener, true);
                    }
                    (window as any).__electronRunClickCaptureListener = function (event: MouseEvent) {
                        const target = event.target as HTMLElement | null;
                        const path = typeof event.composedPath === 'function'
                            ? event.composedPath().slice(0, 8).map((node) => {
                                if (!(node instanceof Element)) {
                                    return String(node);
                                }
                                const id = node.id ? `#${node.id}` : '';
                                const className = typeof node.className === 'string' && node.className.trim().length > 0
                                    ? `.${node.className.trim().replace(/\s+/g, '.')}`
                                    : '';
                                return `${node.tagName.toLowerCase()}${id}${className}`;
                            })
                            : [];
                        (window as any)[key] = {
                            type: event.type,
                            button: event.button,
                            buttons: event.buttons,
                            detail: event.detail,
                            clientX: event.clientX,
                            clientY: event.clientY,
                            altKey: event.altKey,
                            ctrlKey: event.ctrlKey,
                            metaKey: event.metaKey,
                            shiftKey: event.shiftKey,
                            target: target
                                ? {
                                    tagName: target.tagName.toLowerCase(),
                                    id: target.id || null,
                                    className: (
                                        typeof target.className === 'string'
                                            ? target.className
                                            : ((target.className as SVGAnimatedString | undefined)?.baseVal ?? '')
                                    ) || null,
                                    text: (target.textContent ?? '').trim().slice(0, 200),
                                }
                                : null,
                            path,
                            timestamp: Date.now(),
                        };
                    };
                    window.addEventListener('click', (window as any).__electronRunClickCaptureListener, { capture: true, once: true });
                });

                await page.waitForSelector(selector, { timeout: timeoutMs });
                await page.click(selector);
                await delay(40);

                const eventDetails = await page.evaluate(() => {
                    return (window as any).__electronRunLastClickEvent ?? null;
                });

                return {
                    clicked: selector,
                    target: targetInfo,
                    event: eventDetails,
                };
            }

            case 'type': {
                const [
                    selector,
                    text,
                ] = args as [string, string];
                if (!selector || !text) {
                    throw new Error('Selector and text required');
                }
                await page.type(selector, text);
                return { typed: text, into: selector };
            }

            case 'content': {
                const selector = args[0] as string;
                if (!selector) {
                    throw new Error('No selector provided');
                }
                const el = await page.$(selector);
                if (!el) {
                    return null;
                }
                return await el.evaluate(element => element.textContent);
            }

            case 'waitfor': {
                const selector = args[0] as string;
                if (!selector) {
                    throw new Error('No selector provided');
                }
                const timeoutMs = parsePositiveInt(args[1], 10_000, 300_000);
                await page.waitForSelector(selector, { timeout: timeoutMs });
                return {
                    selector,
                    found: true,
                    timeoutMs,
                };
            }

            case 'resize': {
                const width = parsePositiveInt(args[0], 0, 10_000);
                const height = parsePositiveInt(args[1], 0, 10_000);
                if (!width || !height) {
                    throw new Error('Width and height required');
                }
                await page.setViewport({ width, height });
                return {
                    resized: { width, height },
                    viewport: page.viewport(),
                };
            }

            case 'viewport': {
                const viewport = page.viewport();
                if (viewport) {
                    return {
                        viewport,
                        source: 'puppeteer',
                    };
                }

                const dimensions = await page.evaluate(() => ({
                    innerWidth: window.innerWidth,
                    innerHeight: window.innerHeight,
                    outerWidth: window.outerWidth,
                    outerHeight: window.outerHeight,
                    devicePixelRatio: window.devicePixelRatio,
                }));
                return {
                    viewport: null,
                    source: 'window',
                    dimensions,
                };
            }

            case 'openPdf': {
                const pdfPath = args[0] as string;
                if (!pdfPath) {
                    throw new Error('PDF path required');
                }
                const requestedBasename = basename(pdfPath).toLowerCase();
                type TViewerSnapshot = {
                    viewerIndex: number;
                    isVisible: boolean;
                    numPages: number | null;
                    currentPage: number | null;
                    isLoading: boolean | null;
                    workingCopyPath: string | null;
                    renderedPageContainers: number;
                    renderedCanvasCount: number;
                    renderedTextSpanCount: number;
                    visibleSkeletonCount: number;
                };
                type TOpenPdfState = {
                    numPages: number | null;
                    currentPage: number | null;
                    isLoading: boolean | null;
                    workingCopyPath: string | null;
                    renderedPageContainers: number;
                    renderedCanvasCount: number;
                    renderedTextSpanCount: number;
                    visibleSkeletonCount: number;
                    hasViewer: boolean;
                    hasEmptyState: boolean;
                    viewerIndex: number | null;
                    viewerCount: number;
                    visibleViewerCount: number;
                    matchingViewerCount: number;
                    viewers: TViewerSnapshot[];
                    openTrigger?: {
                        token: string;
                        status: 'pending' | 'resolved' | 'rejected';
                        error: string | null;
                    } | null;
                };

                const isRequestedDocumentLoaded = (workingCopyPath: string | null | undefined) => {
                    if (!workingCopyPath) {
                        return false;
                    }
                    return basename(workingCopyPath).toLowerCase() === requestedBasename;
                };
                const isViewerReady = (viewer: Pick<TViewerSnapshot, 'numPages' | 'isLoading' | 'renderedPageContainers' | 'renderedCanvasCount' | 'renderedTextSpanCount'>) => {
                    const hasPages = (viewer.numPages ?? 0) > 0 || viewer.renderedPageContainers > 0;
                    const notLoading = viewer.isLoading === false || viewer.isLoading === null;
                    const hasRenderedContent = viewer.renderedCanvasCount > 0 || viewer.renderedTextSpanCount > 0;
                    return hasPages && notLoading && hasRenderedContent;
                };
                const findRequestedReadyViewer = (state: TOpenPdfState) => {
                    return state.viewers
                        .filter(viewer => (
                            isRequestedDocumentLoaded(viewer.workingCopyPath)
                            && isViewerReady(viewer)
                        ))
                        .sort((left, right) => {
                            const leftScore = (left.isVisible ? 10_000 : 0) + left.viewerIndex;
                            const rightScore = (right.isVisible ? 10_000 : 0) + right.viewerIndex;
                            return rightScore - leftScore;
                        })[0] ?? null;
                };

                const readViewerState = async (token?: string) => await page.evaluate((requestedPathBasename: string, requestedToken?: string) => {
                    const hosts = Array.from(document.querySelectorAll('#pdf-viewer')) as Array<HTMLElement & {
                        __vueParentComponent?: {
                            setupState?: {
                                numPages?: number;
                                currentPage?: number;
                                isLoading?: boolean;
                                workingCopyPath?: string | null;
                            };
                        };
                    }>;
                    const viewers = hosts.map((host, viewerIndex) => {
                        const setupState = host.__vueParentComponent?.setupState;
                        const pageContainers = host.querySelectorAll('.page_container');
                        const isHostVisible = (() => {
                            if (!host.isConnected) {
                                return false;
                            }

                            let current: HTMLElement | null = host;
                            while (current) {
                                const style = window.getComputedStyle(current);
                                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                                    return false;
                                }
                                current = current.parentElement;
                            }

                            const rect = host.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        })();
                        return {
                            viewerIndex,
                            isVisible: isHostVisible,
                            numPages: setupState?.numPages ?? null,
                            currentPage: setupState?.currentPage ?? null,
                            isLoading: setupState?.isLoading ?? null,
                            workingCopyPath: setupState?.workingCopyPath ?? null,
                            renderedPageContainers: pageContainers.length,
                            renderedCanvasCount: host.querySelectorAll('.page_container .page_canvas canvas').length,
                            renderedTextSpanCount: host.querySelectorAll('.page_container .text-layer span, .page_container .textLayer span').length,
                            visibleSkeletonCount: Array.from(host.querySelectorAll('.page_container .pdf-page-skeleton'))
                                .filter((node) => {
                                    const element = node as HTMLElement;
                                    if (!element || !element.isConnected) {
                                        return false;
                                    }
                                    let current: HTMLElement | null = element;
                                    while (current) {
                                        const style = window.getComputedStyle(current);
                                        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                                            return false;
                                        }
                                        current = current.parentElement;
                                    }
                                    const rect = element.getBoundingClientRect();
                                    return rect.width > 0 && rect.height > 0;
                                })
                                .length,
                        };
                    });

                    const selectedViewer = viewers
                        .slice()
                        .sort((left, right) => {
                            const leftBasename = (left.workingCopyPath ?? '')
                                .replace(/\\/g, '/')
                                .split('/')
                                .pop()
                                ?.toLowerCase() ?? '';
                            const rightBasename = (right.workingCopyPath ?? '')
                                .replace(/\\/g, '/')
                                .split('/')
                                .pop()
                                ?.toLowerCase() ?? '';

                            let leftScore = 0;
                            if (requestedPathBasename && leftBasename === requestedPathBasename) {
                                leftScore += 1_000_000;
                            }
                            if (left.isVisible) {
                                leftScore += 10_000;
                            }
                            if ((left.numPages ?? 0) > 0 || left.renderedPageContainers > 0) {
                                leftScore += 500;
                            }
                            if (left.renderedCanvasCount > 0 || left.renderedTextSpanCount > 0) {
                                leftScore += 250;
                            }
                            if (left.isLoading === false) {
                                leftScore += 100;
                            }

                            let rightScore = 0;
                            if (requestedPathBasename && rightBasename === requestedPathBasename) {
                                rightScore += 1_000_000;
                            }
                            if (right.isVisible) {
                                rightScore += 10_000;
                            }
                            if ((right.numPages ?? 0) > 0 || right.renderedPageContainers > 0) {
                                rightScore += 500;
                            }
                            if (right.renderedCanvasCount > 0 || right.renderedTextSpanCount > 0) {
                                rightScore += 250;
                            }
                            if (right.isLoading === false) {
                                rightScore += 100;
                            }

                            return rightScore - leftScore;
                        })[0] ?? null;

                    const trigger = (window as any).__electronRunOpenPdfTrigger as {
                        token?: string;
                        status?: 'pending' | 'resolved' | 'rejected';
                        error?: string | null;
                    } | undefined;
                    const openTrigger = (
                        requestedToken
                        && trigger
                        && trigger.token === requestedToken
                    )
                        ? {
                            token: trigger.token ?? '',
                            status: trigger.status ?? 'pending',
                            error: trigger.error ?? null,
                        }
                        : null;
                    const visibleEmptyStates = Array.from(document.querySelectorAll('.empty-state'))
                        .filter((node) => {
                            const element = node as HTMLElement;
                            if (!element || !element.isConnected) {
                                return false;
                            }
                            let current: HTMLElement | null = element;
                            while (current) {
                                const style = window.getComputedStyle(current);
                                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                                    return false;
                                }
                                current = current.parentElement;
                            }
                            const rect = element.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        });
                    const selected = selectedViewer ?? {
                        viewerIndex: -1,
                        numPages: null,
                        currentPage: null,
                        isLoading: null,
                        workingCopyPath: null,
                        renderedPageContainers: 0,
                        renderedCanvasCount: 0,
                        renderedTextSpanCount: 0,
                        visibleSkeletonCount: 0,
                    };
                    const matchingViewerCount = viewers.filter((viewer) => {
                        const workingCopyBasename = (viewer.workingCopyPath ?? '')
                            .replace(/\\/g, '/')
                            .split('/')
                            .pop()
                            ?.toLowerCase() ?? '';
                        return workingCopyBasename === requestedPathBasename;
                    }).length;

                    return {
                        numPages: selected.numPages,
                        currentPage: selected.currentPage,
                        isLoading: selected.isLoading,
                        workingCopyPath: selected.workingCopyPath,
                        renderedPageContainers: selected.renderedPageContainers,
                        renderedCanvasCount: selected.renderedCanvasCount,
                        renderedTextSpanCount: selected.renderedTextSpanCount,
                        visibleSkeletonCount: selected.visibleSkeletonCount,
                        hasViewer: viewers.length > 0,
                        hasEmptyState: visibleEmptyStates.length > 0,
                        viewerIndex: selected.viewerIndex >= 0 ? selected.viewerIndex : null,
                        viewerCount: viewers.length,
                        visibleViewerCount: viewers.filter(viewer => viewer.isVisible).length,
                        matchingViewerCount,
                        viewers,
                        openTrigger,
                    } satisfies TOpenPdfState;
                }, requestedBasename, token);

                const beforeState = await readViewerState();
                const triggerToken = await page.evaluate((path: string, triggerTimeoutMs: number) => {
                    const token = `open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                    (window as any).__electronRunOpenPdfTrigger = {
                        token,
                        status: 'pending',
                        error: null,
                    };

                    const openFileDirect = (window as any).__openFileDirect;
                    if (typeof openFileDirect !== 'function') {
                        (window as any).__electronRunOpenPdfTrigger = {
                            token,
                            status: 'rejected',
                            error: 'window.__openFileDirect is not available',
                        };
                        return token;
                    }

                    Promise.resolve()
                        .then(async () => {
                            await Promise.race([
                                openFileDirect(path),
                                new Promise((_, reject) => {
                                    setTimeout(() => reject(new Error('openFileDirect trigger timeout')), triggerTimeoutMs);
                                }),
                            ]);
                            (window as any).__electronRunOpenPdfTrigger = {
                                token,
                                status: 'resolved',
                                error: null,
                            };
                        })
                        .catch((error: unknown) => {
                            const message = error instanceof Error ? error.message : String(error);
                            (window as any).__electronRunOpenPdfTrigger = {
                                token,
                                status: 'rejected',
                                error: message,
                            };
                        });

                    return token;
                }, pdfPath, OPEN_PDF_TRIGGER_TIMEOUT_MS);

                const start = Date.now();
                let lastState: TOpenPdfState = beforeState;
                while (Date.now() - start < OPEN_PDF_READY_TIMEOUT_MS) {
                    lastState = await readViewerState(triggerToken as string);

                    if (lastState.openTrigger?.status === 'rejected') {
                        throw new Error(lastState.openTrigger.error || 'openPdf failed');
                    }

                    if (findRequestedReadyViewer(lastState)) {
                        await delay(250);
                        break;
                    }

                    await delay(250);
                }

                const state = await readViewerState();
                const readyViewer = findRequestedReadyViewer(state);
                if (!readyViewer) {
                    const loadedPaths = state.viewers
                        .map(viewer => `${viewer.viewerIndex}:${viewer.workingCopyPath ?? '<none>'}${viewer.isVisible ? ':visible' : ''}`)
                        .join(', ');
                    throw new Error(`openPdf readiness timeout for ${pdfPath} (viewer paths: ${loadedPaths || '<none>'})`);
                }

                const normalizedState: TOpenPdfState = {
                    ...state,
                    numPages: readyViewer.numPages,
                    currentPage: readyViewer.currentPage,
                    isLoading: readyViewer.isLoading,
                    workingCopyPath: readyViewer.workingCopyPath,
                    renderedPageContainers: readyViewer.renderedPageContainers,
                    renderedCanvasCount: readyViewer.renderedCanvasCount,
                    renderedTextSpanCount: readyViewer.renderedTextSpanCount,
                    visibleSkeletonCount: readyViewer.visibleSkeletonCount,
                    viewerIndex: readyViewer.viewerIndex,
                };

                return {
                    opened: pdfPath,
                    state: normalizedState,
                };
            }

            case 'health': {
                const health = await page.evaluate(() => {
                    const nuxtRoot = document.querySelector('#__nuxt');
                    return {
                        bodyExists: document.body !== null,
                        nuxtRootChildren: nuxtRoot?.children.length ?? 0,
                        openFileDirect: typeof (window as any).__openFileDirect,
                        electronAPI: typeof (window as any).electronAPI,
                        bodyTextLength: (document.body?.innerText ?? '').trim().length,
                        title: document.title,
                        url: window.location.href,
                    };
                });
                const ready = health.openFileDirect === 'function'
                    && health.electronAPI === 'object'
                    && health.bodyExists
                    && health.nuxtRootChildren > 0;
                return {
                    ready,
                    health,
                    consoleCount: consoleMessages.length,
                    devtoolsEventCount: devtoolsEvents.length,
                };
            }

            default:
                throw new Error(`Unknown command: ${command}`);
        }
    };
}
