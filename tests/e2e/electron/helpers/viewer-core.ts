import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { DEFAULT_TIMEOUT_MS } from './viewer-dom';

export async function waitForPdfLoaded(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
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
}

export async function openPdfInApp(page: Page, pdfPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.evaluate(async (path: string) => {
        const openFileDirect = (window as Window & { __openFileDirect?: (value: string) => Promise<void> }).__openFileDirect;
        if (typeof openFileDirect !== 'function') {
            throw new Error('window.__openFileDirect is not available');
        }
        await openFileDirect(path);
    }, pdfPath);

    await waitForPdfLoaded(page, timeoutMs);
}

export async function waitForViewerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
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
        await delay(100);
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
    const hasSidebar = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
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
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
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

export async function openAnnotationsTab(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await ensureSidebarOpen(page, timeoutMs);

    const tabPoint = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        if (!host) {
            return null;
        }

        const tabs = Array.from(host.querySelectorAll<HTMLElement>('.pdf-sidebar [role="tab"]'));
        if (tabs.length === 0) {
            return null;
        }

        const target = tabs.find((tab) => (
            tab.querySelector('span')?.className.includes('i-lucide:sticky-note')
        )) ?? tabs[0];
        if (!target) {
            return null;
        }

        const rect = target.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });

    if (!tabPoint) {
        throw new Error('Annotation tab trigger not found');
    }

    await page.mouse.click(tabPoint.x, tabPoint.y);

    await page.waitForFunction(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        const panel = host?.querySelector('.notes-panel') as HTMLElement | null;
        if (!panel) {
            return false;
        }
        const rect = panel.getBoundingClientRect();
        const style = window.getComputedStyle(panel);
        return rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    }, {timeout: timeoutMs});
}

export async function scrollViewerToPage(page: Page, pageNumber: number) {
    const scrolled = await page.evaluate((targetPageNumber: number) => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
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

    await delay(250);
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

    await delay(350);
}
