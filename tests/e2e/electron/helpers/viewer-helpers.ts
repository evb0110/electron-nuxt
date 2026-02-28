import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';

const DEFAULT_TIMEOUT_MS = 30_000;

interface IPoint {
    x: number;
    y: number;
}

async function findVisiblePointInActiveHost(page: Page, selector: string, text?: string): Promise<IPoint | null> {
    return page.evaluate(({
        targetSelector,
        targetText,
    }) => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 100
                    && rect.height > 100
                );
            }) as HTMLElement | undefined;
        if (!host) {
            return null;
        }

        const nodes = Array.from(host.querySelectorAll<HTMLElement>(targetSelector))
            .filter((node) => {
                const rect = node.getBoundingClientRect();
                const style = window.getComputedStyle(node);
                if (rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                    return false;
                }
                if (!targetText) {
                    return true;
                }
                return (node.textContent ?? '').trim() === targetText;
            });

        const target = nodes[0];
        if (!target) {
            return null;
        }

        const rect = target.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    }, {
        targetSelector: selector,
        targetText: text ?? null,
    });
}

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

async function waitForAnnotationEditorLayerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
        if (!viewer || viewer.classList.contains('pdfViewer--resize-transition')) {
            return false;
        }

        const firstPage = host.querySelector('.page_container');
        const editorLayer = firstPage?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        if (!editorLayer) {
            return false;
        }

        const layerStyle = window.getComputedStyle(editorLayer);
        return layerStyle.pointerEvents !== 'none';
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

export async function clickAnnotationTool(page: Page, label: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openAnnotationsTab(page, timeoutMs);
    await waitForViewerInteractive(page, timeoutMs);

    const point = await findVisiblePointInActiveHost(page, '.notes-panel .tool-button .tool-button-label', label);
    if (!point) {
        throw new Error(`Annotation tool not found: ${label}`);
    }

    await page.mouse.click(point.x, point.y);
    const waitUntilActive = async (waitTimeout: number) => {
        await page.waitForFunction((expectedLabel: string) => {
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
            const activeLabel = host.querySelector('.notes-panel .tool-button.is-active .tool-button-label');
            return (activeLabel?.textContent ?? '').trim() === expectedLabel;
        }, {timeout: waitTimeout}, label);
    };

    try {
        await waitUntilActive(Math.min(timeoutMs, 4_000));
    } catch {
        // Fallback path: click tool button in page context directly.
        await page.evaluate((expectedLabel: string) => {
            const host = Array.from(document.querySelectorAll('.workspace-host'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                }) as HTMLElement | undefined;
            const labelNode = Array.from(host?.querySelectorAll('.notes-panel .tool-button .tool-button-label') ?? [])
                .find(node => (node.textContent ?? '').trim() === expectedLabel);
            const button = labelNode?.closest('button') as HTMLButtonElement | null;
            button?.click();
        }, label);
        await waitUntilActive(Math.max(4_000, timeoutMs));
    }
}

export async function setAnnotationColor(page: Page, colorHex: string) {
    await openAnnotationsTab(page);

    const updated = await page.evaluate((nextColor: string) => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        const input = host?.querySelector<HTMLInputElement>('#annotation-color-input');
        if (!input) {
            return false;
        }
        input.value = nextColor;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }, colorHex);

    if (!updated) {
        throw new Error('Annotation color input not found');
    }
}

export async function getActiveToolLabel(page: Page) {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return (host?.querySelector('.notes-panel .tool-button.is-active .tool-button-label')?.textContent ?? '').trim() || null;
    });
}

export async function getFreeTextEditorCount(page: Page) {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return host?.querySelectorAll('.freeTextEditor').length ?? 0;
    });
}

export async function getHighlightEditorCount(page: Page) {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return host?.querySelectorAll('.highlightEditor').length ?? 0;
    });
}

export async function clickPageAtRatio(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    const point = await page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
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

        const targetSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const pageContainer = host.querySelector<HTMLElement>(targetSelector);
        if (!pageContainer) {
            return null;
        }

        const rect = pageContainer.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width * xRatio),
            y: Math.round(rect.top + rect.height * yRatio),
        };
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });

    if (!point) {
        throw new Error(`Target page not found${pageNumber ? ` (page ${pageNumber})` : ''}`);
    }

    await page.mouse.click(point.x, point.y);
}

export async function createFreeTextAnnotation(page: Page, text: string, position?: {
    x: number;
    y: number;
}, pageNumber?: number) {
    const before = await getFreeTextEditorCount(page);
    await clickAnnotationTool(page, 'Text');
    await waitForAnnotationEditorLayerInteractive(page);
    await clickPageAtRatio(page, position ?? {
        x: 0.4,
        y: 0.3,
    }, pageNumber);
    const waitForEditor = async (timeoutMs: number) => {
        await page.waitForFunction((minCount: number) => {
            const host = Array.from(document.querySelectorAll('.workspace-host'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                }) as HTMLElement | undefined;
            return (host?.querySelectorAll('.freeTextEditor').length ?? 0) > minCount;
        }, {timeout: timeoutMs}, before);
    };

    try {
        await waitForEditor(DEFAULT_TIMEOUT_MS);
    } catch {
        // Fallback path: reclick Text tool, then click text-layer center directly.
        await clickAnnotationTool(page, 'Text');
        await waitForAnnotationEditorLayerInteractive(page, Math.min(DEFAULT_TIMEOUT_MS, 8_000));
        const textLayerPoint = await page.evaluate((targetPageNumber: number | null) => {
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

            const pageSelector = targetPageNumber
                ? `.page_container[data-page="${targetPageNumber}"]`
                : '.page_container';
            const pageContainer = host.querySelector<HTMLElement>(pageSelector);
            const textLayer = pageContainer?.querySelector<HTMLElement>('.text-layer, .textLayer');
            const target = textLayer ?? pageContainer;
            if (!target) {
                return null;
            }

            const rect = target.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        }, pageNumber ?? null);

        if (textLayerPoint) {
            await page.mouse.click(textLayerPoint.x, textLayerPoint.y);
        }

        await waitForEditor(8_000);
    }

    const editorPoint = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }

        const rect = editor.getBoundingClientRect();
        return {
            x: Math.round(rect.left + Math.max(4, rect.width / 2)),
            y: Math.round(rect.top + Math.max(4, rect.height / 2)),
        };
    });

    if (!editorPoint) {
        const debugState = await page.evaluate(() => {
            const host = Array.from(document.querySelectorAll('.workspace-host'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                }) as HTMLElement | undefined;
            return {
                activeTool: (host?.querySelector('.notes-panel .tool-button.is-active .tool-button-label')?.textContent ?? '').trim(),
                pageCount: host?.querySelectorAll('.page_container').length ?? 0,
                textLayerCount: host?.querySelectorAll('.text-layer, .textLayer').length ?? 0,
                freeTextCount: host?.querySelectorAll('.freeTextEditor').length ?? 0,
            };
        });
        throw new Error(`Failed to locate created FreeText editor (${JSON.stringify(debugState)})`);
    }

    await page.mouse.click(editorPoint.x, editorPoint.y);
    await page.keyboard.type(text, { delay: 10 });
    await delay(150);

    return getFreeTextEditorCount(page);
}

export async function deleteLatestFreeTextAnnotation(page: Page) {
    const before = await getFreeTextEditorCount(page);
    if (before === 0) {
        return 0;
    }

    await clickAnnotationTool(page, 'Select');
    await waitForViewerInteractive(page);

    const editorPoint = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }

        const overlay = editor.querySelector<HTMLElement>('.overlay');
        const targetRect = (overlay ?? editor).getBoundingClientRect();
        return {
            x: Math.round(targetRect.left + Math.max(4, Math.min(targetRect.width - 4, 8))),
            y: Math.round(targetRect.top + Math.max(4, Math.min(targetRect.height - 4, 8))),
        };
    });

    if (!editorPoint) {
        return before;
    }

    await page.mouse.click(editorPoint.x, editorPoint.y);
    await delay(120);
    await page.keyboard.press('Delete');

    const waitForCountDrop = async (timeoutMs: number) => {
        await page.waitForFunction((previousCount: number) => {
            const host = Array.from(document.querySelectorAll('.workspace-host'))
                .find((candidate) => {
                    const element = candidate as HTMLElement;
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' && rect.width > 100 && rect.height > 100;
                }) as HTMLElement | undefined;
            return (host?.querySelectorAll('.freeTextEditor').length ?? 0) < previousCount;
        }, {timeout: timeoutMs}, before);
    };

    try {
        await waitForCountDrop(Math.min(DEFAULT_TIMEOUT_MS, 3_500));
    } catch {
        // Fallback: right-click and use context menu delete action.
        await page.mouse.click(editorPoint.x, editorPoint.y, { button: 'right' });
        await page.waitForSelector('.annotation-context-menu .pdf-context-menu__action--danger', {timeout: 4_000});
        await page.click('.annotation-context-menu .pdf-context-menu__action--danger');
        await waitForCountDrop(DEFAULT_TIMEOUT_MS);
    }

    return getFreeTextEditorCount(page);
}

export async function createHighlightFromVisibleText(page: Page) {
    const before = await getHighlightEditorCount(page);
    await clickAnnotationTool(page, 'Highlight');

    const dragPoints = await page.evaluate(() => {
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

        const spans = Array.from(host.querySelectorAll<HTMLElement>('.page_container .text-layer span, .page_container .textLayer span'))
            .filter((span) => (span.textContent ?? '').trim().length > 0);
        if (spans.length < 2) {
            return null;
        }

        const first = spans[0]?.getBoundingClientRect();
        const second = spans[1]?.getBoundingClientRect();
        if (!first || !second) {
            return null;
        }

        return {
            x1: Math.round(first.left + 2),
            y1: Math.round(first.top + first.height / 2),
            x2: Math.round(second.right - 2),
            y2: Math.round(second.top + second.height / 2),
        };
    });

    if (!dragPoints) {
        throw new Error('Unable to locate visible text spans for highlight creation');
    }

    await page.mouse.move(dragPoints.x1, dragPoints.y1);
    await page.mouse.down();
    await delay(80);
    await page.mouse.move(dragPoints.x2, dragPoints.y2, { steps: 8 });
    await delay(80);
    await page.mouse.up();

    await page.waitForFunction((previousCount: number) => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return (host?.querySelectorAll('.highlightEditor').length ?? 0) > previousCount;
    }, {timeout: DEFAULT_TIMEOUT_MS}, before);

    return getHighlightEditorCount(page);
}

export async function openContextMenuOnLatestFreeText(page: Page) {
    await clickAnnotationTool(page, 'Select');

    const point = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }
        const rect = editor.getBoundingClientRect();
        return {
            x: Math.round(rect.left + Math.max(4, rect.width / 2)),
            y: Math.round(rect.top + Math.max(4, rect.height / 2)),
        };
    });

    if (!point) {
        return {
            visible: false,
            items: [] as string[],
        };
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    await delay(200);

    return page.evaluate(() => {
        const menu = document.querySelector('.annotation-context-menu');
        const items = Array.from(document.querySelectorAll('.annotation-context-menu button, .annotation-context-menu [role="menuitem"]'))
            .map(item => (item.textContent ?? '').trim())
            .filter(Boolean);
        return {
            visible: Boolean(menu),
            items,
        };
    });
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

export async function countFreeTextEditorsOnPage(page: Page, pageNumber: number) {
    return page.evaluate((targetPageNumber: number) => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        if (!host) {
            return 0;
        }
        return host.querySelectorAll(`.page_container[data-page="${targetPageNumber}"] .freeTextEditor`).length;
    }, pageNumber);
}

export async function getFirstFreeTextComputedColor(page: Page) {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        const editor = host?.querySelector<HTMLElement>('.freeTextEditor [contenteditable], .freeTextEditor');
        if (!editor) {
            return null;
        }
        return window.getComputedStyle(editor).color;
    });
}

export async function getLinkOverlayCount(page: Page) {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return host?.querySelectorAll('.pdf-link-overlay-layer .pdf-link-overlay').length ?? 0;
    });
}

export async function installOpenExternalSpy(page: Page) {
    return page.evaluate(() => {
        const electronApi = (window as Window & {
            electronAPI?: {shell?: {openExternal?: (url: string) => Promise<unknown>;};};
            __e2eOpenExternalCalls?: string[];
            __e2eOriginalOpenExternal?: (url: string) => Promise<unknown>;
            __e2eLinkOverlayClickSpyInstalled?: boolean;
        }).electronAPI;

        const root = window as Window & {
            __e2eOpenExternalCalls?: string[];
            __e2eOriginalOpenExternal?: (url: string) => Promise<unknown>;
            __e2eLinkOverlayClickSpyInstalled?: boolean;
        };
        root.__e2eOpenExternalCalls = [];
        const installLinkClickFallback = () => {
            if (root.__e2eLinkOverlayClickSpyInstalled) {
                return true;
            }

            document.addEventListener('click', (event: Event) => {
                const target = event.target as HTMLElement | null;
                const link = target?.closest<HTMLAnchorElement>('.pdf-link-overlay-layer .pdf-link-overlay');
                const href = link?.getAttribute('href');
                if (href) {
                    root.__e2eOpenExternalCalls?.push(String(href));
                    // Stop the event before the component-level click handler
                    // calls electronAPI.shell.openExternal during E2E runs.
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    event.stopPropagation();
                }
            }, true);
            root.__e2eLinkOverlayClickSpyInstalled = true;
            return true;
        };

        if (!electronApi?.shell || typeof electronApi.shell.openExternal !== 'function') {
            return installLinkClickFallback();
        }

        const descriptor = Object.getOwnPropertyDescriptor(electronApi.shell, 'openExternal');
        const canOverride = !descriptor || descriptor.writable || descriptor.set || descriptor.configurable;

        if (canOverride) {
            if (!root.__e2eOriginalOpenExternal) {
                root.__e2eOriginalOpenExternal = electronApi.shell.openExternal.bind(electronApi.shell);
            }

            electronApi.shell.openExternal = async (url: string) => {
                root.__e2eOpenExternalCalls?.push(String(url));
                return;
            };
            return true;
        }

        return installLinkClickFallback();
    });
}

export async function clickFirstLinkOverlay(page: Page) {
    const point = await findVisiblePointInActiveHost(page, '.pdf-link-overlay-layer .pdf-link-overlay');
    if (!point) {
        throw new Error('No visible link overlay found');
    }
    await page.mouse.click(point.x, point.y);
}

export async function readOpenExternalCalls(page: Page) {
    return page.evaluate(() => {
        return (window as Window & { __e2eOpenExternalCalls?: string[] }).__e2eOpenExternalCalls ?? [];
    });
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
