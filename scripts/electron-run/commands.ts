import {
    basename,
    join,
} from 'node:path';
import { mkdirSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import {
    COMMAND_EXECUTION_TIMEOUT_MS,
    OPEN_PDF_READY_TIMEOUT_MS,
    OPEN_PDF_TRIGGER_TIMEOUT_MS,
    screenshotDirPath,
    type ISessionState,
    type TDevtoolsEvent,
    type TElectronRunCommand,
} from './shared';

const DEFAULT_CONSOLE_LIMIT = 50;
const DEFAULT_DEVTOOLS_LIMIT = 120;
const DEFAULT_SCREENSHOT_INTERVAL_MS = 1000;
const DEFAULT_SCREENSHOT_COUNT = 5;
const TRUTHY_BOOLEAN_TOKENS = [
    '1',
    'true',
    'yes',
    'y',
    'on',
    'full',
] as const;
const FALSY_BOOLEAN_TOKENS = [
    '0',
    'false',
    'no',
    'n',
    'off',
] as const;
type TTruthyBooleanToken = typeof TRUTHY_BOOLEAN_TOKENS[number];
type TFalsyBooleanToken = typeof FALSY_BOOLEAN_TOKENS[number];
const DEVTOOLS_SECTION_VALUES = [
    'summary',
    'console',
    'network',
    'errors',
    'metrics',
    'all',
] as const;
type TDevtoolsSection = typeof DEVTOOLS_SECTION_VALUES[number];
const DEVTOOLS_SECTION_SET = new Set<TDevtoolsSection>(DEVTOOLS_SECTION_VALUES);
const DEVTOOLS_EVENT_SUMMARY_TEMPLATE: Record<TDevtoolsEvent['kind'], number> = {
    console: 0,
    request: 0,
    response: 0,
    requestfailed: 0,
    pageerror: 0,
    error: 0,
};

function isTruthyBooleanToken(value: string): value is TTruthyBooleanToken {
    return (TRUTHY_BOOLEAN_TOKENS as readonly string[]).includes(value);
}

function isFalsyBooleanToken(value: string): value is TFalsyBooleanToken {
    return (FALSY_BOOLEAN_TOKENS as readonly string[]).includes(value);
}

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
    if (isTruthyBooleanToken(normalized)) {
        return true;
    }
    if (isFalsyBooleanToken(normalized)) {
        return false;
    }
    return fallback;
}

function normalizeEventLimit(value: unknown, fallback: number) {
    return parsePositiveInt(value, fallback, 2000);
}

function getDevtoolsSummary(events: readonly TDevtoolsEvent[]) {
    return events.reduce((acc, event) => {
        acc[event.kind] += 1;
        return acc;
    }, { ...DEVTOOLS_EVENT_SUMMARY_TEMPLATE });
}

function parseStringArg(args: readonly unknown[], index: number) {
    const value = args[index];
    if (typeof value !== 'string') {
        return null;
    }
    return value;
}

function parseRequiredStringArg(args: readonly unknown[], index: number, errorMessage: string) {
    const value = parseStringArg(args, index);
    if (!value) {
        throw new Error(errorMessage);
    }
    return value;
}

function parseDevtoolsSection(value: unknown) {
    if (typeof value === 'undefined') {
        return 'summary';
    }
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.toLowerCase();
    if (DEVTOOLS_SECTION_SET.has(normalized as TDevtoolsSection)) {
        return normalized as TDevtoolsSection;
    }
    return null;
}

type TTakeScreenshot = (name: string, fullPage?: boolean) => Promise<string>;

interface ICommandContext {
    sessionState: ISessionState;
    takeScreenshot: TTakeScreenshot;
}

type TSessionCommandHandler = (context: ICommandContext, args: unknown[]) => Promise<unknown> | unknown;

function isErrorDevtoolsEvent(event: TDevtoolsEvent) {
    if (event.kind === 'error' || event.kind === 'pageerror' || event.kind === 'requestfailed') {
        return true;
    }
    if (event.kind === 'console') {
        return event.level === 'error' || event.level === 'warn';
    }
    if (event.kind === 'response') {
        return typeof event.status === 'number' && event.status >= 400;
    }
    return false;
}

async function handleDevtoolsCommand(context: ICommandContext, args: unknown[]) {
    const {
        page,
        devtoolsEvents,
    } = context.sessionState;
    const section = parseDevtoolsSection(args[0]);
    if (!section) {
        throw new Error('Unknown devtools section. Use summary|console|network|errors|metrics|all');
    }
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
            events: events.filter(isErrorDevtoolsEvent),
        };
    }

    const metrics = await page.metrics();
    if (section === 'metrics') {
        return {
            section,
            metrics,
            viewport: page.viewport(),
            url: page.url(),
        };
    }
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

function commandTimeout(command: string) {
    return delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
        throw new Error(`${command} command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
    });
}

function createSleepFn() {
    return async (ms: number) => {
        const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
        await delay(duration);
    };
}

async function handleRunCommand(context: ICommandContext, args: unknown[]) {
    const code = parseRequiredStringArg(args, 0, 'No code provided');
    const asyncFn = new Function(
        'page', 'screenshot', 'sleep', 'wait',
        `return (async () => { ${code} })()`,
    );
    const sleepFn = createSleepFn();

    return Promise.race([
        asyncFn(context.sessionState.page, (name: string) => context.takeScreenshot(name, false), sleepFn, sleepFn),
        commandTimeout('run'),
    ]);
}

async function handleClickCommand(context: ICommandContext, args: unknown[]) {
    const { page } = context.sessionState;
    const selector = parseRequiredStringArg(args, 0, 'No selector provided');
    const timeoutMs = parsePositiveInt(args[1], 8_000, 120_000);
    const targetInfo = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
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
        window.addEventListener('click', (window as any).__electronRunClickCaptureListener, {
            capture: true,
            once: true,
        });
    });

    await page.waitForSelector(selector, { timeout: timeoutMs });
    await page.click(selector);
    await delay(40);

    return {
        clicked: selector,
        target: targetInfo,
        event: await page.evaluate(() => {
            return (window as any).__electronRunLastClickEvent ?? null;
        }),
    };
}

async function handleOpenPdfCommand(context: ICommandContext, args: unknown[]) {
    const { page } = context.sessionState;
    const pdfPath = parseRequiredStringArg(args, 0, 'PDF path required');
    const requestedBasename = basename(pdfPath).toLowerCase();
    interface IViewerSnapshot {
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
    }
    interface IOpenPdfState {
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
        viewers: IViewerSnapshot[];
        openTrigger?: {
            token: string;
            status: 'pending' | 'resolved' | 'rejected';
            error: string | null;
        } | null;
    }

    const isRequestedDocumentLoaded = (workingCopyPath: string | null | undefined) => {
        if (!workingCopyPath) {
            return false;
        }
        return basename(workingCopyPath).toLowerCase() === requestedBasename;
    };
    const isViewerReady = (viewer: Pick<IViewerSnapshot, 'numPages' | 'isLoading' | 'renderedPageContainers' | 'renderedCanvasCount' | 'renderedTextSpanCount'>) => {
        const hasPages = (viewer.numPages ?? 0) > 0 || viewer.renderedPageContainers > 0;
        const notLoading = viewer.isLoading === false || viewer.isLoading === null;
        const hasRenderedContent = viewer.renderedCanvasCount > 0 || viewer.renderedTextSpanCount > 0;
        return hasPages && notLoading && hasRenderedContent;
    };
    const findRequestedReadyViewer = (state: IOpenPdfState) => {
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

    const readViewerState = (token?: string) => page.evaluate((requestedPathBasename: string, requestedToken?: string) => {
        const hosts = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'));
        const isElementVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
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
        };
        const viewers = hosts.map((host, viewerIndex) => {
            const setupState = (host as HTMLElement & {__vueParentComponent?: {setupState?: {
                numPages?: number;
                currentPage?: number;
                isLoading?: boolean;
                workingCopyPath?: string | null;
            };};}).__vueParentComponent?.setupState;
            const pageContainers = host.querySelectorAll('.page_container');
            return {
                viewerIndex,
                isVisible: isElementVisible(host),
                numPages: setupState?.numPages ?? null,
                currentPage: setupState?.currentPage ?? null,
                isLoading: setupState?.isLoading ?? null,
                workingCopyPath: setupState?.workingCopyPath ?? null,
                renderedPageContainers: pageContainers.length,
                renderedCanvasCount: host.querySelectorAll('.page_container .page_canvas canvas').length,
                renderedTextSpanCount: host.querySelectorAll('.page_container .text-layer span, .page_container .textLayer span').length,
                visibleSkeletonCount: Array.from(host.querySelectorAll('.page_container .pdf-page-skeleton'))
                    .filter(node => isElementVisible(node as HTMLElement))
                    .length,
            };
        });
        const getPathBasename = (path: string | null) => {
            return (path ?? '')
                .replace(/\\/g, '/')
                .split('/')
                .pop()
                ?.toLowerCase() ?? '';
        };
        const scoreViewer = (viewer: typeof viewers[number]) => {
            let score = 0;
            if (requestedPathBasename && getPathBasename(viewer.workingCopyPath) === requestedPathBasename) {
                score += 1_000_000;
            }
            if (viewer.isVisible) {
                score += 10_000;
            }
            if ((viewer.numPages ?? 0) > 0 || viewer.renderedPageContainers > 0) {
                score += 500;
            }
            if (viewer.renderedCanvasCount > 0 || viewer.renderedTextSpanCount > 0) {
                score += 250;
            }
            if (viewer.isLoading === false) {
                score += 100;
            }
            return score;
        };

        const selectedViewer = viewers
            .slice()
            .sort((left, right) => scoreViewer(right) - scoreViewer(left))[0] ?? null;

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
            .filter(node => isElementVisible(node as HTMLElement));
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
            return getPathBasename(viewer.workingCopyPath) === requestedPathBasename;
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
        } satisfies IOpenPdfState;
    }, requestedBasename, token);

    const beforeState = await readViewerState();
    const triggerToken = await page.evaluate((path: string, triggerTimeoutMs: number) => {
        const token = `open-${crypto.randomUUID()}`;
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
    let lastState: IOpenPdfState = beforeState;
    while (Date.now() - start < OPEN_PDF_READY_TIMEOUT_MS) {
        lastState = await readViewerState(triggerToken);

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

    const normalizedState: IOpenPdfState = {
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

async function handleHealthCommand(context: ICommandContext) {
    const {
        page,
        consoleMessages,
        devtoolsEvents,
    } = context.sessionState;
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

const COMMAND_HANDLERS: Record<TElectronRunCommand, TSessionCommandHandler> = {
    ping() {
        return {
            status: 'ok',
            uptime: process.uptime(),
        };
    },
    async screenshot(context, args) {
        const name = parseStringArg(args, 0) ?? `screenshot-${Date.now()}`;
        const fullPage = parseBooleanArg(args[1]);
        return {
            screenshot: await context.takeScreenshot(name, fullPage),
            fullPage,
        };
    },
    async screenshots(context, args) {
        const baseName = sanitizeSnapshotName(parseStringArg(args, 0) ?? `timelapse-${Date.now()}`);
        const count = parsePositiveInt(args[1], DEFAULT_SCREENSHOT_COUNT, 240);
        const intervalMs = parseNonNegativeInt(args[2], DEFAULT_SCREENSHOT_INTERVAL_MS, 60_000);
        const fullPage = parseBooleanArg(args[3]);
        const captures: Array<{
            index: number;
            path: string;
            timestamp: number
        }> = [];

        for (let index = 0; index < count; index += 1) {
            const ordinal = String(index + 1).padStart(3, '0');
            captures.push({
                index: index + 1,
                path: await context.takeScreenshot(`${baseName}-${ordinal}`, fullPage),
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
    },
    console(context, args) {
        const level = parseStringArg(args, 0) ?? 'all';
        const limit = normalizeEventLimit(args[1], DEFAULT_CONSOLE_LIMIT);
        const messages = context.sessionState.consoleMessages;
        const filtered = level === 'all'
            ? messages
            : messages.filter((message) => message.type === level);
        return {
            level,
            limit,
            messages: filtered.slice(-limit),
        };
    },
    devtools: handleDevtoolsCommand,
    run: handleRunCommand,
    eval(context, args) {
        const code = parseRequiredStringArg(args, 0, 'No code provided');
        return Promise.race([
            context.sessionState.page.evaluate(code),
            commandTimeout('eval'),
        ]);
    },
    click: handleClickCommand,
    async type(context, args) {
        const selector = parseRequiredStringArg(args, 0, 'Selector and text required');
        const text = parseRequiredStringArg(args, 1, 'Selector and text required');
        await context.sessionState.page.type(selector, text);
        return {
            typed: text,
            into: selector,
        };
    },
    async content(context, args) {
        const selector = parseRequiredStringArg(args, 0, 'No selector provided');
        const el = await context.sessionState.page.$(selector);
        return el ? el.evaluate(element => element.textContent) : null;
    },
    async waitfor(context, args) {
        const selector = parseRequiredStringArg(args, 0, 'No selector provided');
        const timeoutMs = parsePositiveInt(args[1], 10_000, 300_000);
        await context.sessionState.page.waitForSelector(selector, { timeout: timeoutMs });
        return {
            selector,
            found: true,
            timeoutMs,
        };
    },
    async resize(context, args) {
        const width = parsePositiveInt(args[0], 0, 10_000);
        const height = parsePositiveInt(args[1], 0, 10_000);
        if (!width || !height) {
            throw new Error('Width and height required');
        }
        await context.sessionState.page.setViewport({
            width,
            height,
        });
        return {
            resized: {
                width,
                height,
            },
            viewport: context.sessionState.page.viewport(),
        };
    },
    async viewport(context) {
        const { page } = context.sessionState;
        const viewport = page.viewport();
        if (viewport) {
            return {
                viewport,
                source: 'puppeteer',
            };
        }

        return {
            viewport: null,
            source: 'window',
            dimensions: await page.evaluate(() => ({
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                outerWidth: window.outerWidth,
                outerHeight: window.outerHeight,
                devicePixelRatio: window.devicePixelRatio,
            })),
        };
    },
    openPdf: handleOpenPdfCommand,
    health: handleHealthCommand,
};

function createCommandContext(sessionState: ISessionState): ICommandContext {
    const ssDirPath = screenshotDirPath();
    return {
        sessionState,
        async takeScreenshot(name: string, fullPage = false) {
            mkdirSync(ssDirPath, { recursive: true });
            const filepath = join(ssDirPath, `${sanitizeSnapshotName(name)}.png`);
            await sessionState.page.screenshot({
                path: filepath,
                fullPage,
            });
            return filepath;
        },
    };
}

export function createCommandHandler(getSessionState: () => ISessionState | null) {
    return async function handleCommand(command: TElectronRunCommand, args: unknown[]) {
        const sessionState = getSessionState();
        if (!sessionState) {
            throw new Error('Session not initialized');
        }
        return await COMMAND_HANDLERS[command](createCommandContext(sessionState), args);
    };
}
