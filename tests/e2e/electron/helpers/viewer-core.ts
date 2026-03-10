import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import {
    DEFAULT_TIMEOUT_MS,
    waitForActiveWorkspaceHost,
} from './viewer-dom';

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
            lastState = await page.evaluate(() => {
                const nuxtRoot = document.querySelector('#__nuxt');
                return {
                    electronAPI: typeof (window as Window & { electronAPI?: unknown }).electronAPI,
                    openFileDirect: typeof (window as Window & { __openFileDirect?: unknown }).__openFileDirect,
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

export async function waitForPdfLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await runWithExecutionContextRetry(page, async () => {
        await waitForActiveWorkspaceHost(page, timeoutMs);

        await page.waitForFunction(() => {
            const isVisibleHost = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
            };

            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isVisibleHost);
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            if (!host) {
                return false;
            }

            const viewer = host.querySelector('#pdf-viewer');
            if (!viewer) {
                return false;
            }

            const pages = viewer.querySelectorAll('.page_container');
            if (pages.length === 0) {
                return false;
            }

            const renderedContentCount = viewer.querySelectorAll('.page_canvas canvas, .text-layer span, .textLayer span').length;
            return renderedContentCount > 0;
        }, {timeout: timeoutMs});

        await waitForViewerInteractive(page, timeoutMs);
    });
}

export async function openPdfInApp(page: Page, pdfPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));

        try {
            await waitForRendererBindings(page, Math.min(remainingMs, 8_000));

            const openResult = await runWithExecutionContextRetry(page, async () => {
                return page.evaluate(async (path: string) => {
                    const openFileDirect = (window as Window & { __openFileDirect?: (value: string) => Promise<void> }).__openFileDirect;
                    if (typeof openFileDirect !== 'function') {
                        return false;
                    }
                    await openFileDirect(path);
                    return true;
                }, pdfPath);
            });

            if (!openResult) {
                lastError = new Error('window.__openFileDirect is not available');
                await delay(250);
                continue;
            }

            await waitForPdfLoaded(page, remainingMs);
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
    throw new Error(`Failed to open PDF in app within ${timeoutMs}ms.${detail}`);
}

export async function waitForViewerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await waitForActiveWorkspaceHost(page, timeoutMs);

    await page.waitForFunction(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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
    const point = await page.evaluate((label: string) => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button.toolbar-btn[aria-label]'));
        const target = buttons.find((button) => {
            if (button.getAttribute('aria-label') !== label || button.disabled) {
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

        if (!target) {
            return null;
        }

        const rect = target.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    }, ariaLabel);

    if (!point) {
        const overflowPoint = await page.evaluate(() => {
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
                        || element.querySelector('.i-lucide-ellipsis')
                        || element.querySelector('.iconify.i-lucide-ellipsis'),
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
            throw new Error(`Visible toolbar button not found: ${ariaLabel}`);
        }

        await page.mouse.click(overflowPoint.x, overflowPoint.y);
        await page.waitForSelector('.overflow-menu', { timeout: 4_000 });

        const overflowItemPoint = await page.evaluate((label: string) => {
            const items = Array.from(document.querySelectorAll<HTMLElement>('.overflow-menu .overflow-menu-item'));
            const target = items.find((item) => {
                const labelNode = item.querySelector('.overflow-menu-label');
                if ((labelNode?.textContent ?? '').trim() !== label) {
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
        }, ariaLabel);

        if (!overflowItemPoint) {
            throw new Error(`Toolbar action not found in overflow menu: ${ariaLabel}`);
        }
        await page.mouse.click(overflowItemPoint.x, overflowItemPoint.y);
        await page.waitForFunction(() => {
            const menu = document.querySelector('.overflow-menu');
            if (!menu) {
                return true;
            }
            const style = window.getComputedStyle(menu as HTMLElement);
            return (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0
            );
        }, {timeout: 4_000});
        return;
    }

    await page.mouse.click(point.x, point.y);
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

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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
        await clickVisibleToolbarButton(page, 'Toggle Sidebar');
    }

    await page.waitForFunction(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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

    const scrolled = await page.evaluate((targetPageNumber: number) => {
        const getVisibleViewerHost = () => {
            const viewerHosts = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'));
            return viewerHosts.find((element) => {
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
                return rect.width > 100 && rect.height > 100;
            }) ?? null;
        };

        const viewerHost = getVisibleViewerHost();
        const exposed = (viewerHost as HTMLElement & { __vueParentComponent?: { exposed?: { scrollToPage?: (page: number) => void; }; }; }).__vueParentComponent?.exposed;
        if (typeof exposed?.scrollToPage === 'function') {
            exposed.scrollToPage(targetPageNumber);
            return true;
        }

        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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
        return true;
    }, pageNumber);

    if (!scrolled) {
        throw new Error(`Unable to scroll to page ${pageNumber}`);
    }

    await waitForToolbarCurrentPage(page, pageNumber);
}

async function readActiveViewerCurrentPageState(page: Page) {
    return page.evaluate(() => {
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

        const viewers = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'))
            .map((host, viewerIndex) => {
                const setupState = (host as HTMLElement & { __vueParentComponent?: { setupState?: { currentPage?: number; }; }; }).__vueParentComponent?.setupState;
                return {
                    viewerIndex,
                    isVisible: isVisibleElement(host),
                    currentPage: setupState?.currentPage ?? null,
                };
            })
            .filter(viewer => viewer.isVisible)
            .sort((left, right) => right.viewerIndex - left.viewerIndex);

        return viewers[0]?.currentPage ?? null;
    });
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
    await page.click('.page-controls-inline-input', { clickCount: 3 });
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

        const viewerStateCurrentPage = Array.from(document.querySelectorAll<HTMLElement>('#pdf-viewer'))
            .map((host, viewerIndex) => {
                const setupState = (host as HTMLElement & { __vueParentComponent?: { setupState?: { currentPage?: number; }; }; }).__vueParentComponent?.setupState;
                return {
                    viewerIndex,
                    isVisible: isVisibleElement(host),
                    currentPage: setupState?.currentPage ?? null,
                };
            })
            .filter(viewer => viewer.isVisible)
            .sort((left, right) => right.viewerIndex - left.viewerIndex)[0]?.currentPage ?? null;

        if (viewerStateCurrentPage === targetPage) {
            return true;
        }

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

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
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

export async function saveViaWindowHandle(page: Page) {
    const saved = await page.evaluate(async () => {
        const save = (window as Window & { __handleSave?: () => Promise<void> }).__handleSave;
        if (typeof save !== 'function') {
            return false;
        }
        await save();
        return true;
    });

    if (!saved) {
        throw new Error('window.__handleSave is not available');
    }

    await page.waitForFunction(() => {
        const hasPendingToolbarLoading = document.querySelector('.toolbar-btn.is-loading');
        if (hasPendingToolbarLoading) {
            return false;
        }

        const savingStatuses = Array.from(document.querySelectorAll('.note-window__status, .pdf-annotation-note-window__status'));
        return savingStatuses.length === 0;
    }, {timeout: DEFAULT_TIMEOUT_MS});
}
