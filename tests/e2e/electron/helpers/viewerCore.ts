import type { Page } from 'puppeteer-core';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/getE2EWindow';
import { delay } from 'es-toolkit/promise';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    DEFAULT_TIMEOUT_MS,
    waitForActiveWorkspaceHost,
} from '@tests/e2e/electron/helpers/viewerDom';
import {
    callWorkspaceCommand,
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const TOOLBAR_ACTION_ICON_HINTS: Record<string, string[]> = {
    'Toggle Sidebar': [
        '.i-ph-sidebar-simple',
        '.iconify.i-ph-sidebar-simple',
    ],
    'Save': [
        '.i-ph-floppy-disk',
        '.iconify.i-ph-floppy-disk',
    ],
    'Save As': [
        '.i-ph-floppy-disk-back',
        '.iconify.i-ph-floppy-disk-back',
    ],
    'Print': [
        '.i-ph-printer',
        '.iconify.i-ph-printer',
    ],
    'Undo': [
        '.i-ph-arrow-u-up-left',
        '.iconify.i-ph-arrow-u-up-left',
    ],
    'Redo': [
        '.i-ph-arrow-u-up-right',
        '.iconify.i-ph-arrow-u-up-right',
    ],
};

interface IAutomationFileOpenGrantApi {
    __allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;
    electronAPI?: { documents?: { recentFiles?: { add?: (value: string) => Promise<void>; }; }; };
}

function getToolbarActionIconHints(label: string) {
    return TOOLBAR_ACTION_ICON_HINTS[label] ?? [];
}

function isExecutionContextDestroyedError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Frame was detached/i.test(error.message);
}

function describeError(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function getPathBasename(path: string) {
    return path
        .replace(/\\/gu, '/')
        .split('/')
        .pop()
        ?.toLowerCase() ?? '';
}

function getGeneratedPdfBasenameForImage(path: string) {
    const basename = getPathBasename(path);
    return /\.(?:a?png|avif|bmp|gif|ico|jpe?g|svgz?|tiff?|webp)$/iu.test(basename)
        ? basename.replace(/\.[^.]+$/u, '.pdf')
        : '';
}

async function runWithExecutionContextRetry<T>(
    page: Page,
    task: () => Promise<T>,
) {
    try {
        return await task();
    } catch (error) {
        if (!isExecutionContextDestroyedError(error)) {
            throw error;
        }

        await delay(1_000);
        return task();
    }
}

async function waitForRendererBindings(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastState: {
        electronAPI: string;
        openFileDirect: string;
        nuxtRootChildren: number;
        url: string;
    } | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            lastState = await evaluateInPage(page, () => {
                const nuxtRoot = document.querySelector('#__nuxt');
                return {
                    electronAPI: typeof (window as IE2EWindow & { electronAPI?: unknown }).electronAPI,
                    openFileDirect: typeof (window as IE2EWindow & { __openFileDirect?: unknown }).__openFileDirect,
                    nuxtRootChildren: nuxtRoot?.children.length ?? 0,
                    url: window.location.href,
                };
            });

            if (
                lastState.electronAPI === 'object'
                && lastState.openFileDirect === 'function'
                && lastState.nuxtRootChildren > 0
            ) {
                return;
            }
        } catch (error) {
            if (!isExecutionContextDestroyedError(error)) {
                throw error;
            }
        }

        await delay(250);
    }

    const detail = lastState
        ? `openFileDirect=${lastState.openFileDirect}, electronAPI=${lastState.electronAPI}, nuxtRootChildren=${lastState.nuxtRootChildren}, url=${lastState.url}`
        : 'renderer state unavailable';
    throw new Error(`Renderer bindings did not become ready within ${timeoutMs}ms (${detail})`);
}

async function waitForActiveDocumentPath(page: Page, path: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await installWorkspaceExposeProbe(page);
    await waitForFunctionInPage(page, (payload: {
        basename: string;
        generatedPdfBasename: string;
        path: string;
    }) => {
        const normalize = (value: unknown) => typeof value === 'string'
            ? value.replace(/\\/gu, '/').toLowerCase()
            : '';
        const basenameOf = (value: unknown) => normalize(value).split('/').pop() ?? '';
        const requestedPath = normalize(payload.path);
        const requestedBasename = payload.basename;
        const api = (window as IE2EWindow & {__evbTestApi?: {
            collectWorkspaceDebugState?: () => {activeWorkspaceState?: Record<string, unknown>;};
            readActiveWorkspaceStateValues?: (propertyNames: string[]) => Record<string, unknown>;
        };}).__evbTestApi;
        const activeState = (api?.readActiveWorkspaceStateValues?.([
            'fileName',
            'originalPath',
            'pendingDocumentPath',
            'workingCopyPath',
        ]) ?? api?.collectWorkspaceDebugState?.().activeWorkspaceState ?? {}) as Record<string, unknown>;
        const activeTab = document.querySelector<HTMLElement>('.tab.is-active, [role="tab"][aria-selected="true"]');
        const statusCandidates = Array.from(document.querySelectorAll<HTMLElement>('.status-path, .status-file, .workspace-status, .document-status'))
            .map(candidate => candidate.textContent ?? '');
        const candidates = [
            activeState.fileName,
            activeState.originalPath,
            activeState.pendingDocumentPath,
            activeState.workingCopyPath,
            activeTab?.getAttribute('aria-label'),
            activeTab?.textContent,
            ...statusCandidates,
        ];

        return candidates.some(candidate => {
            const normalized = normalize(candidate);
            const candidateBasename = basenameOf(candidate);
            return normalized === requestedPath
                || candidateBasename === requestedBasename
                || (payload.generatedPdfBasename.length > 0 && candidateBasename === payload.generatedPdfBasename);
        });
    }, {timeout: timeoutMs}, {
        basename: getPathBasename(path),
        generatedPdfBasename: getGeneratedPdfBasenameForImage(path),
        path,
    });
}

async function openFreshTabForDocumentOpen(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const clicked = await runWithExecutionContextRetry(page, async () => evaluateInPage(page, () => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 8
                && rect.height > 8
            );
        };
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button, .tab-new'))
            .find(candidate => (
                !candidate.disabled
                && isVisible(candidate)
                && (
                    candidate.classList.contains('tab-new')
                    || candidate.getAttribute('aria-label')?.trim() === 'New Tab'
                )
            ));
        button?.click();
        return Boolean(button);
    }));
    if (!clicked) {
        throw new Error('Could not open a fresh tab for document open fallback');
    }

    await waitForActiveWorkspaceHost(page, timeoutMs);
    await delay(250);
}

export async function waitForPdfLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForFunctionInPage(page, () => {
            const isElementVisible = (element: HTMLElement | null) => {
                if (!element?.isConnected) {
                    return false;
                }

                let current: HTMLElement | null = element;
                while (current) {
                    const style = window.getComputedStyle(current);
                    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                        return false;
                    }
                    current = current.parentElement;
                }

                const rect = element.getBoundingClientRect();
                return rect.width > 100 && rect.height > 100;
            };
            const viewers = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'));
            const visibleViewers = viewers.filter(isElementVisible);
            const activeViewer = document.querySelector<HTMLElement>('.editor-pane.is-active #pdf-viewer');
            const viewer = (activeViewer && visibleViewers.includes(activeViewer))
                ? activeViewer
                : (visibleViewers.length === 1 ? visibleViewers[0] : null);
            if (!viewer) {
                return false;
            }

            const pages = viewer.querySelectorAll('.page_container');
            if (pages.length === 0) {
                return false;
            }

            const visibleRenderedPageCount = Array.from(pages)
                .filter(pageElement => pageElement.classList.contains('page_container--rendered'))
                .filter((pageElement) => {
                    const rect = pageElement.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                })
                .length;
            if (visibleRenderedPageCount === 0) {
                return false;
            }

            const blockingState = viewer.querySelector([
                '.pdf-loading',
                '.pdf-loading-overlay',
                '.pdf-error',
                '.viewer-error',
                '[data-loading="true"]',
                '[data-error="true"]',
            ].join(','));
            if (blockingState) {
                return false;
            }

            const renderedCanvasCount = viewer.querySelectorAll('.page_container .page_canvas canvas').length;
            const renderedTextSpanCount = viewer.querySelectorAll('.page_container .text-layer span, .page_container .textLayer span').length;
            return renderedCanvasCount + renderedTextSpanCount > 0;
        }, {timeout: timeoutMs});

        await waitForViewerInteractive(page, timeoutMs);
    });
}

export async function waitForDjvuLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForActiveWorkspaceHost(page, timeoutMs);

        await waitForFunctionInPage(page, () => {
            const isVisibleHost = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isVisibleHost);
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            if (!host) {
                return false;
            }

            const pages = host.querySelectorAll('.djvu-page-shell');
            if (pages.length === 0) {
                return false;
            }

            return host.querySelectorAll('.djvu-page-shell img').length > 0;
        }, {timeout: timeoutMs});
    });
}

export async function waitForNativePdfPreviewLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForActiveWorkspaceHost(page, timeoutMs);

        await waitForFunctionInPage(page, () => {
            const isElementVisible = (element: HTMLElement | null) => {
                if (!element?.isConnected) {
                    return false;
                }

                let current: HTMLElement | null = element;
                while (current) {
                    const style = window.getComputedStyle(current);
                    if (
                        style.display === 'none'
                        || style.visibility === 'hidden'
                        || Number(style.opacity || '1') === 0
                    ) {
                        return false;
                    }
                    current = current.parentElement;
                }

                const rect = element.getBoundingClientRect();
                return rect.width > 100 && rect.height > 100;
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isElementVisible);
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
            if (!container || !isElementVisible(container)) {
                return false;
            }

            const standardPdfViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
            if (isElementVisible(standardPdfViewer)) {
                return false;
            }

            const blockingState = host?.querySelector([
                '[data-testid="native-pdf-viewer-error"]',
                '[data-testid="workspace-document-pdf-error"]',
                '[data-testid="workspace-document-djvu-error"]',
                '.native-pdf-page-placeholder',
            ].join(','));
            if (blockingState) {
                return false;
            }

            return Array.from(container.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img'))
                .some((image) => {
                    const rect = image.getBoundingClientRect();
                    return image.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0
                        && rect.width > 100
                        && rect.height > 100;
                });
        }, {timeout: timeoutMs});

        const toolbarDeadline = Date.now() + timeoutMs;
        let lastToolbarSnapshot: Awaited<ReturnType<typeof getWorkspaceToolbarSnapshot>> | null = null;
        while (Date.now() < toolbarDeadline) {
            const toolbarSnapshot = await getWorkspaceToolbarSnapshot(page);
            lastToolbarSnapshot = toolbarSnapshot;
            if (
                toolbarSnapshot
                && toolbarSnapshot.hasPdf
                && !toolbarSnapshot.isOpeningDocument
                && toolbarSnapshot.totalPages > 1
            ) {
                return;
            }
            await delay(100);
        }

        throw new Error(`Native PDF preview toolbar did not settle (${JSON.stringify(lastToolbarSnapshot)})`);
    });
}

async function openPathInApp(
    page: Page,
    path: string,
    waitForLoaded: (page: Page, timeoutMs: number) => Promise<void>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    const startedAt = Date.now();
    let lastError: Error | null = null;
    let openTriggered = false;
    let openBaselineEventId = 0;
    let openedFreshTabAfterBlockedOpen = false;

    while (Date.now() - startedAt < timeoutMs) {
        const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));

        try {
            await waitForRendererBindings(page, Math.min(remainingMs, 8_000));

            if (!openTriggered) {
                openBaselineEventId = await getLatestAutomationEventId(page);
                const openResult = await runWithExecutionContextRetry(page, async () => {
                    return evaluateInPage(page, async (path: string) => {
                        const automationGrant = (window as IE2EWindow & IAutomationFileOpenGrantApi).__allowRendererFileOpenForAutomation;
                        if (typeof automationGrant === 'function') {
                            await automationGrant(path);
                        }

                        const documents = (window as IE2EWindow & IAutomationFileOpenGrantApi).electronAPI?.documents;
                        try {
                            await documents?.recentFiles?.add?.(path);
                        } catch {
                            // Direct-open also exists in browser-like automation contexts where recent files are unavailable.
                        }

                        const openFileDirect = (window as IE2EWindow & { __openFileDirect?: (value: string) => Promise<boolean> }).__openFileDirect;
                        if (typeof openFileDirect !== 'function') {
                            return false;
                        }
                        return openFileDirect(path);
                    }, path);
                });

                if (!openResult) {
                    lastError = new Error('window.__openFileDirect returned false');
                    try {
                        await waitForActiveDocumentPath(page, path, Math.min(3_000, remainingMs));
                        await waitForLoaded(page, remainingMs);
                        return;
                    } catch (error) {
                        lastError = error instanceof Error ? error : new Error(describeError(error));
                        if (!openedFreshTabAfterBlockedOpen) {
                            openedFreshTabAfterBlockedOpen = true;
                            await openFreshTabForDocumentOpen(page, Math.min(remainingMs, 8_000));
                            await delay(250);
                            continue;
                        }
                        await delay(250);
                        continue;
                    }
                }

                openTriggered = true;
            }

            const domWait = (async () => {
                await waitForActiveDocumentPath(page, path, remainingMs);
                await waitForLoaded(page, remainingMs);
            })();
            const eventWait = Promise.all([
                waitForAutomationEvent(page, 'document-opened', {
                    afterEventId: openBaselineEventId,
                    path,
                    timeoutMs: remainingMs,
                }),
                waitForAutomationEvent(page, 'first-page-rendered', {
                    afterEventId: openBaselineEventId,
                    path,
                    timeoutMs: remainingMs,
                }),
            ])
                .then(async (events) => {
                    if (events.every(Boolean)) {
                        return;
                    }
                    await domWait;
                })
                .catch(() => domWait);
            await Promise.race([
                eventWait,
                domWait,
            ]);
            return;
        } catch (error) {
            if (!isExecutionContextDestroyedError(error)) {
                lastError = error instanceof Error ? error : new Error(describeError(error));
            } else {
                lastError = new Error(describeError(error));
            }
            await delay(400);
        }
    }

    const detail = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Failed to open document in app within ${timeoutMs}ms.${detail}`);
}

export async function triggerOpenPathInApp(page: Page, path: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));

        try {
            await waitForRendererBindings(page, Math.min(remainingMs, 8_000));
            const openResult = await runWithExecutionContextRetry(page, async () => {
                return evaluateInPage(page, async (path: string) => {
                    const automationGrant = (window as IE2EWindow & IAutomationFileOpenGrantApi).__allowRendererFileOpenForAutomation;
                    if (typeof automationGrant === 'function') {
                        await automationGrant(path);
                    }

                    const documents = (window as IE2EWindow & IAutomationFileOpenGrantApi).electronAPI?.documents;
                    try {
                        await documents?.recentFiles?.add?.(path);
                    } catch {
                        // Direct-open also exists in browser-like automation contexts where recent files are unavailable.
                    }

                    const openFileDirect = (window as IE2EWindow & { __openFileDirect?: (value: string) => Promise<boolean> }).__openFileDirect;
                    if (typeof openFileDirect !== 'function') {
                        return false;
                    }
                    void openFileDirect(path).catch((error) => {
                        console.error('[E2E] Direct document open failed', error);
                    });
                    return true;
                }, path);
            });

            if (openResult) {
                return;
            }

            lastError = new Error('window.__openFileDirect is not available');
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(describeError(error));
        }

        await delay(400);
    }

    const detail = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Failed to trigger document open within ${timeoutMs}ms.${detail}`);
}

export async function openPdfInApp(page: Page, pdfPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openPathInApp(page, pdfPath, waitForPdfLoaded, timeoutMs);
}

export async function openDjvuInApp(page: Page, djvuPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openPathInApp(page, djvuPath, waitForDjvuLoaded, timeoutMs);
}

export async function openNativePdfPreviewInApp(page: Page, pdfPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openPathInApp(page, pdfPath, waitForNativePdfPreviewLoaded, timeoutMs);
}

export async function readNativePdfPreviewState(page: Page) {
    const domState = await evaluateInPage(page, () => {
        const isElementVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isElementVisible);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const renderedImages = Array.from(container?.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img') ?? [])
            .filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        const standardPdfViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const visibleErrors = Array.from(document.querySelectorAll<HTMLElement>([
            '[data-testid="native-pdf-viewer-error"]',
            '[data-testid="workspace-document-pdf-error"]',
            '[data-testid="workspace-document-djvu-error"]',
            '.native-pdf-page-placeholder',
        ].join(',')))
            .filter(isElementVisible)
            .map(element => (element.textContent ?? '').trim())
            .filter(Boolean);
        const bodyText = document.body.textContent ?? '';
        const crashPatterns = [
            'Array buffer allocation failed',
            'No handler registered',
            'Failed to load PDF',
            'UnknownErrorException',
            'RangeError',
        ];

        return {
            crashText: crashPatterns.filter(pattern => bodyText.includes(pattern)).join('\n'),
            errorTexts: visibleErrors,
            hostDocumentOpenFallbackCount: host?.querySelectorAll('.workspace-host-document-open-fallback').length ?? 0,
            nativeViewerVisible: isElementVisible(container),
            placeholderCount: container?.querySelectorAll('.native-pdf-page-placeholder').length ?? 0,
            renderedImages: renderedImages.length,
            renderedImageSizes: renderedImages.slice(0, 4).map(image => ({
                height: image.naturalHeight,
                width: image.naturalWidth,
            })),
            shellCount: container?.querySelectorAll('.native-pdf-page-shell').length ?? 0,
            skeletonCount: host?.querySelectorAll('.native-pdf-page-shell .pdf-page-skeleton').length ?? 0,
            standardPdfViewerVisible: isElementVisible(standardPdfViewer),
            transitionSurfaceCount: host?.querySelectorAll('.workspace-document-transition-skeleton').length ?? 0,
        };
    });
    const toolbar = await getWorkspaceToolbarSnapshot(page);
    return {
        ...domState,
        toolbar,
    };
}

export async function readNativePdfPreviewLoadingState(page: Page) {
    const domState = await evaluateInPage(page, () => {
        const isElementVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const toRect = (element: HTMLElement | null) => {
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
            };
        };
        const elementOwnsViewportPoint = (owner: HTMLElement | null, rect: ReturnType<typeof toRect>) => {
            if (!owner || !rect) {
                return false;
            }

            const visibleLeft = Math.max(0, rect.left);
            const visibleTop = Math.max(0, rect.top);
            const visibleRight = Math.min(window.innerWidth, rect.left + rect.width);
            const visibleBottom = Math.min(window.innerHeight, rect.top + rect.height);
            if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
                return false;
            }

            const x = Math.min(window.innerWidth - 1, Math.max(0, visibleLeft + (visibleRight - visibleLeft) / 2));
            const y = Math.min(window.innerHeight - 1, Math.max(0, visibleTop + (visibleBottom - visibleTop) / 2));
            const topElement = document.elementFromPoint(x, y);
            return Boolean(topElement && owner.contains(topElement));
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isElementVisible);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const hostDocumentOpenFallback = host?.querySelector<HTMLElement>('.workspace-host-document-open-fallback') ?? null;
        const transitionSurface = host?.querySelector<HTMLElement>('.workspace-document-transition-skeleton') ?? null;
        const transitionPageShell = transitionSurface?.querySelector<HTMLElement>('.workspace-document-transition-skeleton__page-shell') ?? null;
        const emptyState = host?.querySelector<HTMLElement>('.empty-state') ?? null;
        const statusBar = document.querySelector<HTMLElement>('.editor-pane.is-active .status-bar')
            ?? document.querySelector<HTMLElement>('.status-bar');
        const statusPath = statusBar?.querySelector<HTMLElement>('.status-bar-path') ?? null;
        const statusMetricTexts = Array.from(statusBar?.querySelectorAll<HTMLElement>('.status-bar-item') ?? [])
            .map(element => (element.textContent ?? '').trim())
            .filter(Boolean);
        const pageSkeletons = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell .pdf-page-skeleton') ?? []);
        const transitionSkeletons = Array.from(host?.querySelectorAll<HTMLElement>('.workspace-document-transition-skeleton .pdf-page-skeleton') ?? []);
        const pageShells = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell') ?? []);
        const firstVisiblePageShell = pageShells.find(isElementVisible) ?? null;
        const renderedImages = Array.from(container?.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img') ?? [])
            .filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        const transitionPageShellRect = toRect(transitionPageShell);
        const firstVisiblePageShellRect = toRect(firstVisiblePageShell);
        const transitionSkeletonIsTopSurface = isElementVisible(transitionPageShell)
            && elementOwnsViewportPoint(transitionPageShell, transitionPageShellRect);
        const nativeSkeletonIsTopSurface = firstVisiblePageShell
            ? pageSkeletons.some(skeleton => firstVisiblePageShell.contains(skeleton))
                && isElementVisible(firstVisiblePageShell)
                && elementOwnsViewportPoint(firstVisiblePageShell, firstVisiblePageShellRect)
            : false;
        const topPendingSurface = transitionSkeletonIsTopSurface
            ? 'transition'
            : (nativeSkeletonIsTopSurface ? 'native' : 'none');

        return {
            emptyStateVisible: isElementVisible(emptyState),
            emptyStateText: (emptyState?.textContent ?? '').trim(),
            hostDocumentOpenFallbackVisible: isElementVisible(hostDocumentOpenFallback),
            hostDocumentOpenFallbackRect: toRect(hostDocumentOpenFallback),
            transitionSurfaceVisible: isElementVisible(transitionSurface),
            transitionSurfaceRect: toRect(transitionSurface),
            transitionPageShellRect,
            topPendingSurface,
            nativeViewerVisible: isElementVisible(container),
            pageSkeletonCount: pageSkeletons.length,
            visiblePageSkeletonCount: pageSkeletons.filter(isElementVisible).length,
            visibleTransitionSkeletonCount: transitionSkeletons.filter(isElementVisible).length,
            pageShellRects: pageShells.filter(isElementVisible).slice(0, 4).map(toRect),
            renderedImages: renderedImages.length,
            shellCount: container?.querySelectorAll('.native-pdf-page-shell').length ?? 0,
            statusBarVisible: isElementVisible(statusBar),
            statusFileName: (statusPath?.textContent ?? '').trim(),
            statusMetricTexts,
            viewerRect: toRect(container),
            viewport: {
                height: window.innerHeight,
                width: window.innerWidth,
            },
        };
    });
    const toolbar = await getWorkspaceToolbarSnapshot(page);
    return {
        ...domState,
        toolbar,
    };
}

export async function setTabMemoryPolicyForE2E(
    page: Page,
    policy: 'conservative' | 'aggressive',
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await waitForRendererBindings(page, timeoutMs);
    await runWithExecutionContextRetry(page, async () => {
        await evaluateInPage(page, async (policy: 'conservative' | 'aggressive') => {
            const setter = (window as IE2EWindow & {__setTabMemoryPolicyForE2E?: (policy: 'conservative' | 'aggressive') => void;}).__setTabMemoryPolicyForE2E;
            if (typeof setter !== 'function') {
                throw new Error('Tab memory policy automation hook is not available');
            }
            setter(policy);
        }, policy);
    });
    await waitForFunctionInPage(page, (policy: 'conservative' | 'aggressive') => {
        const settingsApi = (window as IE2EWindow & {electronAPI?: {settings?: {get?: () => Promise<{tabMemoryPolicy?: string;}>;};};}).electronAPI?.settings;
        return settingsApi?.get?.().then(settings => settings.tabMemoryPolicy === policy) ?? false;
    }, { timeout: timeoutMs }, policy);
}

export async function waitForViewerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await waitForActiveWorkspaceHost(page, timeoutMs);

    await waitForFunctionInPage(page, () => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        if (!host) {
            return false;
        }

        const viewer = host.querySelector('.pdfViewer');
        if (!viewer) {
            return false;
        }

        const viewerStyle = window.getComputedStyle(viewer);
        if (
            viewer.classList.contains('pdfViewer--resize-transition')
            || viewer.classList.contains('pdfViewer--hidden')
            || viewerStyle.display === 'none'
            || viewerStyle.visibility === 'hidden'
            || Number(viewerStyle.opacity || '1') === 0
        ) {
            return false;
        }

        return true;
    }, {timeout: timeoutMs});
}

export async function clickVisibleToolbarButton(page: Page, ariaLabel: string) {
    const tryClickInlineButton = () => evaluateInPage(page, (args: {
        label: string;
        iconHints: string[];
    }): 'clicked' | 'disabled' | 'not-found' => {
        const matchesToolbarAction = (element: HTMLElement, label: string, iconHints: string[]) => {
            const ariaLabel = element.getAttribute('aria-label')?.trim() ?? '';
            if (ariaLabel === label || ariaLabel.startsWith(`${label} (`)) {
                return true;
            }
            return iconHints.some(selector => Boolean(element.querySelector(selector)));
        };

        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'));
        const candidates = buttons.filter((button) => {
            if (!matchesToolbarAction(button, args.label, args.iconHints)) {
                return false;
            }
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return (
                rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
            );
        });
        const target = candidates.find(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');

        if (!target) {
            return candidates.length > 0 ? 'disabled' : 'not-found';
        }

        target.click();
        return 'clicked';
    }, {
        label: ariaLabel,
        iconHints: getToolbarActionIconHints(ariaLabel),
    });

    let clicked = false;
    const inlineButtonDeadline = Date.now() + 4_000;
    while (Date.now() < inlineButtonDeadline) {
        const result = await tryClickInlineButton();
        if (result === 'clicked') {
            clicked = true;
            break;
        }
        if (result === 'not-found') {
            break;
        }

        await delay(50);
    }

    if (!clicked) {
        const finalInlineAttempt = await tryClickInlineButton();
        if (finalInlineAttempt === 'clicked') {
            return;
        }
        if (finalInlineAttempt === 'disabled') {
            throw new Error(`Visible toolbar button stayed disabled: ${ariaLabel}`);
        }

        const overflowPoint = await evaluateInPage(page, () => {
            const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label], .toolbar-icon-button'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    if (
                        rect.width <= 8
                        || rect.height <= 8
                        || style.display === 'none'
                        || style.visibility === 'hidden'
                        || Number(style.opacity || '1') === 0
                    ) {
                        return false;
                    }
                    return Boolean(
                        element.classList.contains('toolbar-icon-button')
                        || Boolean(element.querySelector('.i-ph-dots-three'))
                        || Boolean(element.querySelector('.iconify.i-ph-dots-three')),
                    );
                });

            if (!trigger || trigger.disabled) {
                return null;
            }
            const rect = trigger.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });

        if (!overflowPoint) {
            const appMenuPoint = await page.evaluate(() => {
                const menuButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                    .find((candidate) => {
                        const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                        const rect = candidate.getBoundingClientRect();
                        const style = window.getComputedStyle(candidate);
                        return (
                            ariaLabel === 'Menu'
                            && rect.width > 8
                            && rect.height > 8
                            && style.display !== 'none'
                            && style.visibility !== 'hidden'
                            && Number(style.opacity || '1') > 0
                            && !candidate.disabled
                            && candidate.getAttribute('aria-disabled') !== 'true'
                        );
                    });
                if (!menuButton) {
                    return null;
                }
                const rect = menuButton.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            });

            if (!appMenuPoint) {
                throw new Error(`Visible toolbar button not found: ${ariaLabel}`);
            }

            await page.mouse.click(appMenuPoint.x, appMenuPoint.y);
            await page.waitForSelector('.app-menu', { timeout: 4_000 });

            const appMenuItemPoint = await page.evaluate((args: {
                label: string;
                iconHints: string[];
            }) => {
                const matchesToolbarAction = (element: HTMLElement, label: string, iconHints: string[]) => {
                    const text = (element.querySelector('.app-menu-label')?.textContent ?? '').trim();
                    if (text === label) {
                        return true;
                    }
                    return iconHints.some(selector => Boolean(element.querySelector(selector)));
                };

                const items = Array.from(document.querySelectorAll<HTMLElement>('.app-menu .app-menu-item'));
                const target = items.find((item) => {
                    if (!matchesToolbarAction(item, args.label, args.iconHints)) {
                        return false;
                    }
                    const rect = item.getBoundingClientRect();
                    const style = window.getComputedStyle(item);
                    return (
                        rect.width > 8
                        && rect.height > 8
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0
                        && !item.hasAttribute('disabled')
                        && item.getAttribute('aria-disabled') !== 'true'
                    );
                });
                if (!target) {
                    return null;
                }
                const rect = target.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            }, {
                label: ariaLabel,
                iconHints: getToolbarActionIconHints(ariaLabel),
            });

            if (!appMenuItemPoint) {
                throw new Error(`Toolbar action not found in app menu: ${ariaLabel}`);
            }

            await page.mouse.click(appMenuItemPoint.x, appMenuItemPoint.y);
            await page.waitForFunction(() => {
                const menu = document.querySelector('.app-menu');
                if (!menu) {
                    return true;
                }
                const style = window.getComputedStyle(menu);
                return (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                );
            }, { timeout: 4_000 });
            return;
        }

        await page.mouse.click(overflowPoint.x, overflowPoint.y);
        await page.waitForSelector('.overflow-menu', { timeout: 4_000 });

        const overflowItemPoint = await page.evaluate((args: {
            label: string;
            iconHints: string[];
        }) => {
            const matchesToolbarAction = (element: HTMLElement, label: string, iconHints: string[]) => {
                const text = (element.querySelector('.overflow-menu-label')?.textContent ?? '').trim();
                if (text === label) {
                    return true;
                }
                return iconHints.some(selector => Boolean(element.querySelector(selector)));
            };

            const items = Array.from(document.querySelectorAll<HTMLElement>('.overflow-menu .overflow-menu-item'));
            const target = items.find((item) => {
                if (!matchesToolbarAction(item, args.label, args.iconHints)) {
                    return false;
                }
                const rect = item.getBoundingClientRect();
                const style = window.getComputedStyle(item);
                return (
                    rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && !item.hasAttribute('disabled')
                    && item.getAttribute('aria-disabled') !== 'true'
                );
            });
            if (!target) {
                return null;
            }
            const rect = target.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        }, {
            label: ariaLabel,
            iconHints: getToolbarActionIconHints(ariaLabel),
        });

        if (!overflowItemPoint) {
            throw new Error(`Toolbar action not found in overflow menu: ${ariaLabel}`);
        }
        await page.mouse.click(overflowItemPoint.x, overflowItemPoint.y);
        await page.waitForFunction(() => {
            const menu = document.querySelector('.overflow-menu');
            if (!menu) {
                return true;
            }
            const style = window.getComputedStyle(menu);
            return (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0
            );
        }, {timeout: 4_000});
        return;
    }

}

export async function clickToolbarButtonWhenEnabled(
    page: Page,
    ariaLabel: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            await clickVisibleToolbarButton(page, ariaLabel);
            return;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await delay(125);
        }
    }

    const elapsedMs = Date.now() - startedAt;
    const detail = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Toolbar action '${ariaLabel}' did not become clickable in ${elapsedMs}ms.${detail}`);
}

export async function ensureSidebarOpen(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await waitForActiveWorkspaceHost(page, timeoutMs);

    const hasSidebar = await page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }
        const sidebar = host.querySelector('.pdf-sidebar');
        if (!sidebar) {
            return false;
        }
        const rect = sidebar.getBoundingClientRect();
        const style = window.getComputedStyle(sidebar);
        return (
            rect.width > 10
            && rect.height > 10
            && style.display !== 'none'
            && style.visibility !== 'hidden'
        );
    });

    if (!hasSidebar) {
        await clickToolbarButtonWhenEnabled(page, 'Toggle Sidebar', timeoutMs);
    }

    await page.waitForFunction(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }
        const sidebar = host.querySelector('.pdf-sidebar');
        if (!sidebar) {
            return false;
        }
        const rect = sidebar.getBoundingClientRect();
        const style = window.getComputedStyle(sidebar);
        return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }, {timeout: timeoutMs});
}

async function isAnnotationsPanelVisible(page: Page) {
    return page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const isVisiblePanel = (element: HTMLElement | null) => {
            if (!element) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.height > 10 && rect.width > 10 && style.display !== 'none' && style.visibility !== 'hidden';
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        return isVisiblePanel(host?.querySelector<HTMLElement>('.notes-panel') ?? null);
    });
}

async function tryActivateAnnotationsTab(page: Page) {
    return page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return 'missing-host';
        }

        const panel = host.querySelector<HTMLElement>('.notes-panel');
        if (panel) {
            const panelStyle = window.getComputedStyle(panel);
            const panelRect = panel.getBoundingClientRect();
            if (
                panelStyle.display !== 'none'
                && panelStyle.visibility !== 'hidden'
                && panelRect.width > 10
                && panelRect.height > 10
            ) {
                return 'already-open';
            }
        }

        const tabs = Array.from(host.querySelectorAll<HTMLElement>('.pdf-sidebar [role="tab"]'));
        if (tabs.length === 0) {
            return 'missing-tabs';
        }

        const target = tabs.find((tab) => {
            const text = [
                tab.getAttribute('aria-label') ?? '',
                tab.getAttribute('title') ?? '',
                tab.textContent ?? '',
                tab.className,
                tab.querySelector('span')?.className ?? '',
                tab.querySelector('svg')?.getAttribute('data-icon') ?? '',
            ]
                .join(' ')
                .toLowerCase();

            return (
                text.includes('notes')
                || text.includes('annotation')
                || text.includes('message-square')
                || text.includes('sticky-note')
            );
        }) ?? tabs[0];

        if (!target) {
            return 'missing-target';
        }

        target.scrollIntoView({
            block: 'center',
            inline: 'center',
        });
        target.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            composed: true,
        }));
        target.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            composed: true,
        }));
        target.click();
        target.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            composed: true,
        }));
        return target.getAttribute('aria-selected') === 'true'
            || target.dataset.state === 'active'
            ? 'activated'
            : 'clicked';
    });
}

export async function openAnnotationsTab(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await ensureSidebarOpen(page, timeoutMs);
    await waitForActiveWorkspaceHost(page, timeoutMs);

    const startedAt = Date.now();
    let lastState = 'not-started';
    let lastError: unknown = null;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            if (await isAnnotationsPanelVisible(page)) {
                return;
            }

            lastState = await tryActivateAnnotationsTab(page);
            if (await isAnnotationsPanelVisible(page)) {
                return;
            }
        } catch (error) {
            lastError = error;
            if (!isExecutionContextDestroyedError(error)) {
                lastState = describeError(error);
            }
        }

        await delay(250);
        try {
            await waitForActiveWorkspaceHost(page, Math.min(2_000, timeoutMs));
        } catch (error) {
            lastError = error;
        }
    }

    const detail = lastError ? describeError(lastError) : lastState;
    throw new Error(`Annotations tab did not open within ${timeoutMs}ms (${detail})`);
}

export async function scrollViewerToPage(page: Page, pageNumber: number) {
    await waitForActiveWorkspaceHost(page);

    const scrollCommand = await callWorkspaceCommand(page, 'scrollToPage', [pageNumber]);
    if (scrollCommand.called) {
        try {
            await waitForToolbarCurrentPage(page, pageNumber, 5_000);
        } catch {
            await goToPageViaToolbar(page, pageNumber);
        }
        return;
    }

    const scrolled = await page.evaluate((targetPageNumber: number) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }

        const viewer = host.querySelector<HTMLElement>('.pdfViewer');
        const pageEl = host.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`);
        if (!viewer || !pageEl) {
            return false;
        }

        viewer.scrollTop = Math.max(0, pageEl.offsetTop - 16);
        viewer.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
    }, pageNumber);

    if (!scrolled) {
        await goToPageViaToolbar(page, pageNumber);
        return;
    }

    try {
        await waitForToolbarCurrentPage(page, pageNumber, 5_000);
    } catch {
        await goToPageViaToolbar(page, pageNumber);
    }
}

async function readActiveViewerCurrentPageState(page: Page) {
    return (await getWorkspaceToolbarSnapshot(page))?.currentPage ?? null;
}

export async function goToPageViaToolbar(page: Page, pageNumber: number) {
    const displayPoint = await page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        const display = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-display'))
            .find(isVisibleElement);
        if (!display) {
            return null;
        }

        const rect = display.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });

    if (!displayPoint) {
        throw new Error('Toolbar page control not found');
    }

    await page.mouse.click(displayPoint.x, displayPoint.y);
    await page.waitForSelector('.page-controls-inline-input', { timeout: DEFAULT_TIMEOUT_MS });
    await page.click('.page-controls-inline-input', { count: 3 });
    await page.keyboard.type(String(pageNumber));
    await page.keyboard.press('Enter');
    await waitForToolbarCurrentPage(page, pageNumber);
}

export async function getToolbarCurrentPage(page: Page) {
    const currentPageFromViewerState = await readActiveViewerCurrentPageState(page);
    if (Number.isFinite(currentPageFromViewerState)) {
        return currentPageFromViewerState;
    }

    return page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        const currentPageText = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current'))
            .find(isVisibleElement)
            ?.textContent
            ?.trim() ?? '';
        const currentPage = Number.parseInt(currentPageText, 10);
        return Number.isFinite(currentPage) ? currentPage : null;
    });
}

export async function waitForToolbarCurrentPage(
    page: Page,
    expectedPage: number,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await page.waitForFunction((targetPage: number) => {
        const isVisibleElement = (element: HTMLElement) => {
            if (!element.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8;
        };

        const currentPageText = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current'))
            .find(isVisibleElement)
            ?.textContent
            ?.trim() ?? '';
        return Number.parseInt(currentPageText, 10) === targetPage;
    }, {timeout: timeoutMs}, expectedPage);
}

export async function waitForActiveThumbnailInView(
    page: Page,
    expectedPage: number,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await page.waitForFunction((targetPage: number) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }

        const container = host.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnails');
        const activeThumbnail = host.querySelector<HTMLElement>(`.pdf-thumbnail.is-active[data-page="${targetPage}"]`);
        if (!container || !activeThumbnail) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const thumbnailRect = activeThumbnail.getBoundingClientRect();
        const margin = 8;

        return (
            thumbnailRect.top >= containerRect.top + margin
            && thumbnailRect.bottom <= containerRect.bottom - margin
        );
    }, { timeout: timeoutMs }, expectedPage);
}

export async function resizeSidebarBy(page: Page, deltaX: number, steps = 12) {
    await ensureSidebarOpen(page);
    await waitForActiveWorkspaceHost(page);

    const resizerPoint = await page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return null;
        }

        const resizer = host.querySelector<HTMLElement>('.sidebar-resizer');
        if (!resizer) {
            return null;
        }

        const rect = resizer.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });

    if (!resizerPoint) {
        throw new Error('Sidebar resizer not found');
    }

    await page.mouse.move(resizerPoint.x, resizerPoint.y);
    await page.mouse.down();
    await page.mouse.move(resizerPoint.x + deltaX, resizerPoint.y, { steps });
    await page.mouse.up();
    await delay(150);
}

export async function saveViaWindowHandle(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const saveBaselineEventId = await getLatestAutomationEventId(page);
    const workspaceSave = await callWorkspaceCommand(page, 'handleSave');
    const saved = workspaceSave.called || await page.evaluate(async () => {
        const save = (window as IE2EWindow & { __handleSave?: () => Promise<unknown> }).__handleSave;
        if (typeof save !== 'function') {
            return false;
        }
        await save();
        return true;
    });

    if (!saved) {
        throw new Error('window.__handleSave is not available');
    }

    const domWait = page.waitForFunction(() => {
        const hasPendingToolbarLoading = document.querySelector('.toolbar-btn.is-loading');
        if (hasPendingToolbarLoading) {
            return false;
        }

        const savingStatuses = Array.from(document.querySelectorAll('.note-window__status, .pdf-annotation-note-window__status'));
        return savingStatuses.length === 0;
    }, {timeout: timeoutMs});
    const eventWait = waitForAutomationEvent(page, 'save-committed', {
        afterEventId: saveBaselineEventId,
        timeoutMs,
    })
        .then(async (event) => {
            if (event) {
                return;
            }
            await domWait;
        })
        .catch(() => domWait);
    await Promise.race([
        eventWait,
        domWait,
    ]);
}
