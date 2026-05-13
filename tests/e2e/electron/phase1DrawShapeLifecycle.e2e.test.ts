import type { Page } from 'puppeteer-core';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    createBlankFixturePdf,
    readPdfAnnotationSummary,
} from './helpers/fixtures';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from './helpers/pageRuntime';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import {
    clickAnnotationTool,
    clickToolbarButtonWhenEnabled,
    openPdfInApp,
    saveViaWindowHandle,
    setAnnotationColor,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from './helpers/viewerHelpers';

const runExtendedDrawShapeLifecycle = process.env.EVB_E2E_DRAW_SHAPES_EXTENDED === '1';
const extendedIt = runExtendedDrawShapeLifecycle ? it : it.skip;

interface IRendererErrorTracker {
    errors: string[];
    detach: () => void;
}

async function enableDebugBrowserLogging(page: Page) {
    await page.evaluate(() => {
        window.localStorage.setItem('evb-viewer:log-level', 'debug');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForFunctionInPage(page, () => {
        const nuxtRoot = document.querySelector('#__nuxt');
        const hasNuxt = Boolean(nuxtRoot && nuxtRoot.children.length > 0);
        const hasOpenFile = typeof (window as Window & { __openFileDirect?: unknown }).__openFileDirect === 'function';
        const hasElectronApi = typeof (window as Window & { electronAPI?: unknown }).electronAPI === 'object';
        return hasNuxt && hasOpenFile && hasElectronApi;
    }, { timeout: 30_000 });
}

function createRendererErrorTracker(page: Page): IRendererErrorTracker {
    const errors: string[] = [];

    const onConsole = (message: {
        type: () => string;
        text: () => string;
    }) => {
        if (message.type() !== 'error') {
            return;
        }

        const text = message.text();
        if (text.includes('[renderer-guard]') || text.includes('Unhandled window error')) {
            errors.push(text);
        }
    };

    const onPageError = (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(`pageerror:${detail}`);
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    return {
        errors,
        detach: () => {
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
        },
    };
}

async function waitForShapeCount(page: Page, expectedCount: number) {
    await waitForFunctionInPage(page, (count: number) => {
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
        const shapes = host?.querySelectorAll('.pdf-shape-overlay > g:not(.is-drawing)') ?? [];
        return shapes.length === count;
    }, { timeout: 20_000 }, expectedCount);
}

async function waitForAnnotationSubtypeCountOnDisk(
    filePath: string,
    subtype: string,
    expectedCount: number,
    timeoutMs = 10_000,
) {
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
        const summary = await readPdfAnnotationSummary(filePath);
        if ((summary.bySubtype[subtype] ?? 0) === expectedCount) {
            return summary;
        }
        await delay(250);
    }

    return readPdfAnnotationSummary(filePath);
}

async function waitForInkCountOnDisk(filePath: string, expectedCount: number, timeoutMs = 10_000) {
    return waitForAnnotationSubtypeCountOnDisk(filePath, 'Ink', expectedCount, timeoutMs);
}

async function waitForLineCountOnDisk(filePath: string, expectedCount: number, timeoutMs = 10_000) {
    return waitForAnnotationSubtypeCountOnDisk(filePath, 'Line', expectedCount, timeoutMs);
}

async function dragInkStroke(
    page: Page,
    points: ReadonlyArray<{
        x: number;
        y: number;
    }>,
    pageNumber = 1,
) {
    await clickAnnotationTool(page, 'Draw');
    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-tool-active`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const didDraw = await evaluateInPage(page, ({
        targetPageNumber,
        ratios,
    }: {
        targetPageNumber: number;
        ratios: ReadonlyArray<{
            x: number;
            y: number;
        }>;
    }) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-tool-active`) ?? null;
        if (!overlay || ratios.length < 2) {
            return false;
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const toClientPoint = (point: {
            x: number;
            y: number;
        }) => ({
            clientX: rect.left + rect.width * point.x,
            clientY: rect.top + rect.height * point.y,
        });
        const dispatchPointerEvent = (
            type: 'pointerdown' | 'pointermove' | 'pointerup',
            point: {
                clientX: number;
                clientY: number;
            },
            buttons: number,
        ) => {
            overlay.dispatchEvent(new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
                button: 0,
                buttons,
                clientX: point.clientX,
                clientY: point.clientY,
            }));
        };

        const start = toClientPoint(ratios[0]!);
        dispatchPointerEvent('pointerdown', start, 1);
        for (const point of ratios.slice(1)) {
            dispatchPointerEvent('pointermove', toClientPoint(point), 1);
        }
        dispatchPointerEvent('pointerup', toClientPoint(ratios[ratios.length - 1]!), 0);
        return true;
    }, {
        targetPageNumber: pageNumber,
        ratios: [...points],
    });

    if (!didDraw) {
        throw new Error('Failed to dispatch ink stroke events');
    }
}

async function dragLineSegment(
    page: Page,
    segment: {
        start: {
            x: number;
            y: number;
        };
        end: {
            x: number;
            y: number;
        };
    },
    pageNumber = 1,
) {
    await clickAnnotationTool(page, 'Line');
    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-tool-active`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const didDraw = await evaluateInPage(page, ({
        targetPageNumber,
        start,
        end,
    }: {
        targetPageNumber: number;
        start: {
            x: number;
            y: number;
        };
        end: {
            x: number;
            y: number;
        };
    }) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-tool-active`) ?? null;
        if (!overlay) {
            return false;
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const midpoint = {
            x: (start.x + end.x) / 2,
            y: (start.y + end.y) / 2,
        };
        const toClientPoint = (point: {
            x: number;
            y: number;
        }) => ({
            clientX: rect.left + rect.width * point.x,
            clientY: rect.top + rect.height * point.y,
        });
        const dispatchPointerEvent = (
            type: 'pointerdown' | 'pointermove' | 'pointerup',
            point: {
                clientX: number;
                clientY: number;
            },
            buttons: number,
        ) => {
            overlay.dispatchEvent(new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
                button: 0,
                buttons,
                clientX: point.clientX,
                clientY: point.clientY,
            }));
        };

        dispatchPointerEvent('pointerdown', toClientPoint(start), 1);
        dispatchPointerEvent('pointermove', toClientPoint(midpoint), 1);
        dispatchPointerEvent('pointermove', toClientPoint(end), 1);
        dispatchPointerEvent('pointerup', toClientPoint(end), 0);
        return true;
    }, {
        targetPageNumber: pageNumber,
        start: segment.start,
        end: segment.end,
    });

    if (!didDraw) {
        throw new Error('Failed to dispatch line segment events');
    }
}

async function dragInkStrokeWithMouse(
    page: Page,
    points: ReadonlyArray<{
        x: number;
        y: number;
    }>,
    pageNumber = 1,
) {
    await clickAnnotationTool(page, 'Draw');
    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-tool-active`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const clientPoints = await evaluateInPage(page, ({
        targetPageNumber,
        ratios,
    }: {
        targetPageNumber: number;
        ratios: ReadonlyArray<{
            x: number;
            y: number;
        }>;
    }) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-tool-active`) ?? null;
        if (!overlay || ratios.length < 2) {
            return null;
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return ratios.map(point => ({
            clientX: rect.left + rect.width * point.x,
            clientY: rect.top + rect.height * point.y,
        }));
    }, {
        targetPageNumber: pageNumber,
        ratios: [...points],
    });

    if (!clientPoints || clientPoints.length < 2) {
        throw new Error('Unable to resolve client points for mouse ink stroke');
    }

    const start = clientPoints[0]!;
    await page.mouse.move(start.clientX, start.clientY);
    await page.mouse.down();
    for (const point of clientPoints.slice(1)) {
        await page.mouse.move(point.clientX, point.clientY, { steps: 6 });
    }
    const end = clientPoints[clientPoints.length - 1]!;
    await page.mouse.move(end.clientX, end.clientY);
    await page.mouse.up();
}

async function clickPagePoint(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    await clickAnnotationTool(page, 'Select');
    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-selection-enabled`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const targetPoint = await evaluateInPage(page, ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
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
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-selection-enabled`) ?? null;
        if (!overlay) {
            return null;
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        const clientX = rect.left + rect.width * ratioX;
        const clientY = rect.top + rect.height * ratioY;

        return {
            clientX,
            clientY,
        };
    }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });

    if (!targetPoint) {
        throw new Error('Unable to resolve click target for shape');
    }

    await page.mouse.move(targetPoint.clientX, targetPoint.clientY);
    await page.mouse.down();
    await page.mouse.up();
}

async function waitForNoVisibleInkAtPoints(page: Page, points: ReadonlyArray<{
    x: number;
    y: number;
}>, pageNumber = 1) {
    for (const point of points) {
        await waitForNoVisibleInkAtPoint(page, point, pageNumber);
    }
}

async function deleteSelectedShape(page: Page) {
    await page.keyboard.press('Delete');
}

async function deleteSelectedShapeViaPropertiesPopup(page: Page) {
    await waitForFunctionInPage(page, () => Boolean(document.querySelector('.annotation-properties-delete')), {timeout: 10_000});

    const buttonPoint = await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.annotation-properties-delete');
        if (!button) {
            return null;
        }

        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });
    if (!buttonPoint) {
        throw new Error('Delete button in annotation properties popup is not visible');
    }

    await page.mouse.click(buttonPoint.x, buttonPoint.y);
}

async function getToolbarSaveDebugState(page: Page) {
    return evaluateInPage(page, () => {
        const saveButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .map((button) => ({
                label: button.getAttribute('aria-label')?.trim() ?? '',
                disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
                className: button.className,
                text: button.textContent?.trim() ?? '',
            }))
            .filter(button => button.label === 'Save' || button.label.startsWith('Save ('));

        let workspaceInstance: unknown = null;
        let currentElement = document.querySelector<HTMLElement>('.editor-group-pane.is-active');
        while (currentElement) {
            const exposed = (currentElement as HTMLElement & {__vueParentComponent?: {exposed?: unknown;};}).__vueParentComponent?.exposed;
            if (
                exposed
                && typeof exposed === 'object'
                && typeof (exposed as { getToolbarSnapshot?: unknown; }).getToolbarSnapshot === 'function'
            ) {
                workspaceInstance = exposed;
                break;
            }
            currentElement = currentElement.parentElement;
        }

        const toolbarSnapshot = (workspaceInstance as { getToolbarSnapshot?: () => unknown; } | null)?.getToolbarSnapshot?.() ?? null;
        const activeTabDirty = Boolean(document.querySelector('.tab.is-active .tab-dirty-dot'));

        return {
            activeTabDirty,
            saveButtons,
            toolbarSnapshot,
        };
    });
}

async function saveViaToolbarButton(page: Page) {
    try {
        await clickToolbarButtonWhenEnabled(page, 'Save', 20_000);
    } catch (error) {
        const state = await getToolbarSaveDebugState(page);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Save toolbar action was not clickable: ${detail}. State: ${JSON.stringify(state)}`);
    }

    await page.waitForFunction(() => {
        const hasPendingToolbarLoading = document.querySelector('.toolbar-btn.is-loading');
        if (hasPendingToolbarLoading) {
            return false;
        }

        const savingStatuses = Array.from(document.querySelectorAll('.note-window__status, .pdf-annotation-note-window__status'));
        return savingStatuses.length === 0;
    }, { timeout: 20_000 });
}

async function waitForNoShapeSelectionUi(page: Page) {
    await waitForFunctionInPage(page, () => {
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
        const selectionOutline = host?.querySelector('.pdf-shape-overlay .selection-outline');
        const propertiesPopup = document.querySelector('.annotation-properties');
        return !selectionOutline && !propertiesPopup;
    }, { timeout: 10_000 });
}

async function waitForActiveColorIndicator(page: Page) {
    await waitForFunctionInPage(page, () => {
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
        const swatches = Array.from(host?.querySelectorAll<HTMLButtonElement>('.notes-panel .swatch') ?? []);
        return swatches.some(swatch => swatch.classList.contains('is-active'));
    }, { timeout: 10_000 });
}

async function waitForNoVisibleInkAtPoint(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    await waitForFunctionInPage(page, ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
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
        const pageContainer = host?.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPageNumber}"]`,
        ) ?? null;
        if (!pageContainer) {
            return false;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return false;
        }

        const canvases = Array.from(pageContainer.querySelectorAll<HTMLCanvasElement>('canvas'));
        if (canvases.length === 0) {
            return false;
        }

        const hasVisibleInk = canvases.some((canvas) => {
            const rect = canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
                return false;
            }

            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) {
                return false;
            }

            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            const centerX = Math.round((rect.width * ratioX) * scaleX);
            const centerY = Math.round((rect.height * ratioY) * scaleY);
            const radius = Math.max(2, Math.round(Math.max(scaleX, scaleY) * 5));
            const startX = Math.max(0, centerX - radius);
            const startY = Math.max(0, centerY - radius);
            const width = Math.min(canvas.width - startX, (radius * 2) + 1);
            const height = Math.min(canvas.height - startY, (radius * 2) + 1);

            if (width <= 0 || height <= 0) {
                return false;
            }

            const imageData = context.getImageData(startX, startY, width, height).data;
            for (let index = 0; index < imageData.length; index += 4) {
                const alpha = imageData[index + 3] ?? 0;
                if (alpha === 0) {
                    continue;
                }

                const red = imageData[index] ?? 0;
                const green = imageData[index + 1] ?? 0;
                const blue = imageData[index + 2] ?? 0;
                const isBlankPagePixel = red >= 248 && green >= 248 && blue >= 248;
                if (!isBlankPagePixel) {
                    return true;
                }
            }

            return false;
        });

        const clientX = pageRect.left + pageRect.width * ratioX;
        const clientY = pageRect.top + pageRect.height * ratioY;
        const overlay = pageContainer.querySelector<SVGElement>('.pdf-shape-overlay');
        const isVisibleGhostElement = (element: Element) => {
            if (overlay?.contains(element) || element.closest('.pdf-shape-overlay')) {
                return false;
            }

            const rect = element.getBoundingClientRect();
            if (
                rect.width <= 0
                || rect.height <= 0
                || clientX < (rect.left - 2)
                || clientX > (rect.right + 2)
                || clientY < (rect.top - 2)
                || clientY > (rect.bottom + 2)
            ) {
                return false;
            }

            const style = window.getComputedStyle(element);
            if (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number(style.opacity || '1') === 0
            ) {
                return false;
            }

            if (element instanceof HTMLElement && element.hidden) {
                return false;
            }

            return true;
        };
        const hasVisibleLayerGhost = (
            Array.from(pageContainer.querySelectorAll<Element>(
                '.annotationLayer .inkAnnotation,'
                + '.annotation-layer .inkAnnotation,'
                + '.annotationEditorLayer .inkEditor,'
                + '.annotationEditorLayer .highlightEditor,'
                + '.annotationEditorLayer .editorAnnotation,'
                + '.annotation-editor-layer .inkEditor,'
                + '.annotation-editor-layer .highlightEditor,'
                + '.annotation-editor-layer .editorAnnotation,'
                + '.annotationLayer .editorAnnotation,'
                + '.annotation-layer .editorAnnotation,'
                + '.annotationLayer [data-annotation-id],'
                + '.annotation-layer [data-annotation-id]',
            )).some(isVisibleGhostElement)
            || Array.from(pageContainer.querySelectorAll<Element>(
                '.annotationLayer svg polyline,'
                + '.annotation-layer svg polyline,'
                + '.annotationEditorLayer .draw use,'
                + '.annotationEditorLayer .draw path,'
                + '.annotation-editor-layer .draw use,'
                + '.annotation-editor-layer .draw path',
            )).some(isVisibleGhostElement)
            || document.elementsFromPoint(clientX, clientY).some((element) => {
                if (!(element instanceof Element)) {
                    return false;
                }

                const layerElement = element.closest('.annotationEditorLayer, .annotation-editor-layer, .annotationLayer, .annotation-layer');
                if (!layerElement || !pageContainer.contains(layerElement) || element === layerElement) {
                    return false;
                }

                return isVisibleGhostElement(element)
                    && Boolean(
                        element instanceof SVGElement
                        || element.closest('.inkEditor')
                        || element.closest('.highlightEditor')
                        || element.closest('.editorAnnotation')
                        || element.closest('[data-annotation-id]'),
                    );
            })
        );

        return !hasVisibleInk && !hasVisibleLayerGhost;
    }, { timeout: 15_000 }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });
}

async function hasVisibleCanvasInkAtPointWithOverlayHidden(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    return evaluateInPage(page, ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
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
        const pageContainer = host?.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPageNumber}"]`,
        ) ?? null;
        if (!pageContainer) {
            return false;
        }

        const overlay = pageContainer.querySelector<SVGElement>('.pdf-shape-overlay');
        const previousDisplay = overlay?.style.display ?? '';
        if (overlay) {
            overlay.style.display = 'none';
        }

        try {
            const canvases = Array.from(pageContainer.querySelectorAll<HTMLCanvasElement>('canvas'));
            return canvases.some((canvas) => {
                const rect = canvas.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
                    return false;
                }

                const context = canvas.getContext('2d', { willReadFrequently: true });
                if (!context) {
                    return false;
                }

                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const centerX = Math.round((rect.width * ratioX) * scaleX);
                const centerY = Math.round((rect.height * ratioY) * scaleY);
                const radius = Math.max(4, Math.round(Math.max(scaleX, scaleY) * 8));
                const startX = Math.max(0, centerX - radius);
                const startY = Math.max(0, centerY - radius);
                const width = Math.min(canvas.width - startX, (radius * 2) + 1);
                const height = Math.min(canvas.height - startY, (radius * 2) + 1);

                if (width <= 0 || height <= 0) {
                    return false;
                }

                const imageData = context.getImageData(startX, startY, width, height).data;
                for (let index = 0; index < imageData.length; index += 4) {
                    const alpha = imageData[index + 3] ?? 0;
                    if (alpha === 0) {
                        continue;
                    }

                    const red = imageData[index] ?? 0;
                    const green = imageData[index + 1] ?? 0;
                    const blue = imageData[index + 2] ?? 0;
                    const isBlankPagePixel = red >= 248 && green >= 248 && blue >= 248;
                    if (!isBlankPagePixel) {
                        return true;
                    }
                }

                return false;
            });
        } finally {
            if (overlay) {
                overlay.style.display = previousDisplay;
            }
        }
    }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });
}

async function getManagedShapeDebugState(page: Page) {
    return evaluateInPage(page, () => {
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
        const viewerRoot = host?.querySelector<HTMLElement>('.pdfViewer') ?? null;
        let currentElement: HTMLElement | null = viewerRoot;
        let pdfViewerInstance: unknown = null;
        while (currentElement) {
            const exposed = (currentElement as HTMLElement & {__vueParentComponent?: {exposed?: unknown;};}).__vueParentComponent?.exposed;
            if (
                exposed
                && typeof exposed === 'object'
                && typeof (exposed as { getAllShapes?: unknown; }).getAllShapes === 'function'
            ) {
                pdfViewerInstance = exposed;
                break;
            }
            currentElement = currentElement.parentElement;
        }
        const normalizedPdfViewerInstance = pdfViewerInstance as
            | {
                getAllShapes?: () => Array<{
                    id: string;
                    type?: string;
                    x?: number;
                    y?: number;
                    width?: number;
                    height?: number;
                    strokeWidth?: number;
                    source?: string;
                    annotationId?: string | null;
                    stableKey?: string | null;
                    points?: Array<{
                        x: number;
                        y: number;
                    }>;
                    strokes?: Array<Array<{
                        x: number;
                        y: number;
                    }>>;
                }>;
                hasShapes?: {value?: boolean;} | boolean;
                selectedShapeId?: {value?: string | null;} | string | null;
                getDeletedEmbeddedShapeAnnotationIds?: () => string[];
                getDeletedEmbeddedShapeStableKeys?: () => string[];
                $?: {setupState?: {hiddenEmbeddedAnnotationIds?: {value?: Set<string>;};};};
            }
            | null;
        const pdfViewerSetupState = normalizedPdfViewerInstance?.$?.setupState ?? null;
        const shapes = normalizedPdfViewerInstance?.getAllShapes?.() ?? [];
        const hiddenIds = Array.from(pdfViewerSetupState?.hiddenEmbeddedAnnotationIds?.value ?? []);
        return {
            hasWorkspace: Boolean(host),
            hasPdfViewer: Boolean(normalizedPdfViewerInstance),
            hasShapes: typeof normalizedPdfViewerInstance?.hasShapes === 'object'
                ? Boolean(normalizedPdfViewerInstance?.hasShapes?.value)
                : Boolean(normalizedPdfViewerInstance?.hasShapes),
            selectedShapeId: typeof normalizedPdfViewerInstance?.selectedShapeId === 'object'
                ? normalizedPdfViewerInstance?.selectedShapeId?.value ?? null
                : normalizedPdfViewerInstance?.selectedShapeId ?? null,
            domShapeCount: host?.querySelectorAll('.pdf-shape-overlay > g:not(.is-drawing)').length ?? 0,
            shapes: shapes.map(shape => ({
                id: shape.id,
                type: shape.type ?? null,
                x: shape.x ?? null,
                y: shape.y ?? null,
                width: shape.width ?? null,
                height: shape.height ?? null,
                strokeWidth: shape.strokeWidth ?? null,
                source: shape.source ?? null,
                annotationId: shape.annotationId ?? null,
                stableKey: shape.stableKey ?? null,
                points: shape.points?.slice(0, 6) ?? null,
                strokes: shape.strokes?.slice(0, 2).map(points => points.slice(0, 6)) ?? null,
            })),
            deletedAnnotationIds: normalizedPdfViewerInstance?.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
            deletedStableKeys: normalizedPdfViewerInstance?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
            hiddenIds,
        };
    });
}

async function expectAnyManagedShapeSelected(page: Page) {
    const state = await getManagedShapeDebugState(page);
    expect(state.selectedShapeId).not.toBeNull();
    return state;
}

async function getPointInteractionDebugState(page: Page, point: {
    x: number;
    y: number;
}, pageNumber = 1) {
    return evaluateInPage(page, ({
        ratioX,
        ratioY,
        targetPageNumber,
    }: {
        ratioX: number;
        ratioY: number;
        targetPageNumber: number;
    }) => {
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
        const pageContainer = host?.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`) ?? null;
        const overlay = pageContainer?.querySelector<SVGElement>('.pdf-shape-overlay') ?? null;
        if (!pageContainer || !overlay) {
            return null;
        }

        const overlayRect = overlay.getBoundingClientRect();
        const clientX = overlayRect.left + overlayRect.width * ratioX;
        const clientY = overlayRect.top + overlayRect.height * ratioY;
        const elementStack = document.elementsFromPoint(clientX, clientY)
            .slice(0, 12)
            .map((element) => ({
                tag: element.tagName,
                className: element instanceof HTMLElement || element instanceof SVGElement
                    ? element.className.baseVal ?? element.className ?? ''
                    : '',
                dataAnnotationId: element instanceof HTMLElement ? element.dataset.annotationId ?? null : null,
            }));

        const overlayShapes = Array.from(overlay.querySelectorAll('g'))
            .map((group, index) => ({
                index,
                className: group.getAttribute('class') ?? '',
                bbox: (() => {
                    try {
                        const box = group.getBBox();
                        return {
                            x: box.x,
                            y: box.y,
                            width: box.width,
                            height: box.height,
                        };
                    } catch {
                        return null;
                    }
                })(),
            }));

        return {
            clientX,
            clientY,
            elementStack,
            overlayShapes,
        };
    }, {
        ratioX: point.x,
        ratioY: point.y,
        targetPageNumber: pageNumber,
    });
}

async function waitForAllShapesEmbedded(page: Page, expectedCount: number) {
    await waitForFunctionInPage(page, (count: number) => {
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
        const viewerRoot = host?.querySelector<HTMLElement>('.pdfViewer') ?? null;
        let currentElement: HTMLElement | null = viewerRoot;
        let pdfViewerInstance: unknown = null;
        while (currentElement) {
            const exposed = (currentElement as HTMLElement & {__vueParentComponent?: {exposed?: unknown;};}).__vueParentComponent?.exposed;
            if (
                exposed
                && typeof exposed === 'object'
                && typeof (exposed as { getAllShapes?: unknown; }).getAllShapes === 'function'
            ) {
                pdfViewerInstance = exposed;
                break;
            }
            currentElement = currentElement.parentElement;
        }
        const normalizedPdfViewerInstance = pdfViewerInstance as
            | {getAllShapes?: () => Array<{
                source?: string;
                annotationId?: string | null;
            }>;}
            | null;
        const shapes = normalizedPdfViewerInstance?.getAllShapes?.() ?? [];
        return (
            shapes.length === count
            && shapes.every(shape => shape.source === 'embedded' && typeof shape.annotationId === 'string' && shape.annotationId.length > 0)
        );
    }, { timeout: 20_000 }, expectedCount);
}

describe('Electron E2E - Phase 1 (Draw Shape Lifecycle)', () => {
    let session: IElectronE2ESession | null = null;
    let rendererErrorTracker: IRendererErrorTracker | null = null;

    beforeEach(async () => {
        session = await startElectronE2ESession(`e2e-draw-shapes-${Date.now()}`);
        if (session?.page) {
            rendererErrorTracker = createRendererErrorTracker(session.page);
            await enableDebugBrowserLogging(session.page);
        }
    });

    afterEach(async () => {
        try {
            expect(rendererErrorTracker?.errors ?? []).toEqual([]);
        } finally {
            rendererErrorTracker?.detach();
            rendererErrorTracker = null;
            await session?.stop();
            session = null;
        }
    });

    it('preserves repeated draw-save-delete-redraw cycles without ghost shapes or auto-selecting new strokes', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.22, 
            },
            {
                x: 0.28,
                y: 0.27, 
            },
            {
                x: 0.42,
                y: 0.35, 
            },
        ]);

        await waitForShapeCount(page, 1);
        await waitForNoShapeSelectionUi(page);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        let annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.28,
            y: 0.27,
        })).toBe(false);

        await clickPagePoint(page, {
            x: 0.28,
            y: 0.27, 
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 0);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.28,
            y: 0.27,
        });

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 0);

        annotationSummary = await waitForInkCountOnDisk(fixturePath, 0);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(0);

        await dragInkStroke(page, [
            {
                x: 0.5,
                y: 0.28, 
            },
            {
                x: 0.6,
                y: 0.38, 
            },
            {
                x: 0.7,
                y: 0.48, 
            },
        ]);

        await waitForShapeCount(page, 1);
        await waitForNoShapeSelectionUi(page);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);

        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.6,
            y: 0.38,
        })).toBe(false);

        await clickPagePoint(page, {
            x: 0.6,
            y: 0.38, 
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 0);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.6,
            y: 0.38,
        });

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 0);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 0);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(0);

        await dragInkStroke(page, [
            {
                x: 0.2,
                y: 0.55, 
            },
            {
                x: 0.34,
                y: 0.6, 
            },
            {
                x: 0.46,
                y: 0.68, 
            },
        ]);

        await waitForShapeCount(page, 1);
        await waitForNoShapeSelectionUi(page);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.34,
            y: 0.6,
        })).toBe(false);
    });

    extendedIt('keeps multiple saved strokes fully managed after save so delete clears them visually before the next save', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-multi-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStrokeWithMouse(page, [
            {
                x: 0.14,
                y: 0.18,
            },
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.22,
                y: 0.225,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.265,
                y: 0.262,
            },
            {
                x: 0.29,
                y: 0.285,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStrokeWithMouse(page, [
            {
                x: 0.42,
                y: 0.255,
            },
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.5,
                y: 0.305,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.6,
                y: 0.365,
            },
            {
                x: 0.63,
                y: 0.39,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStrokeWithMouse(page, [
            {
                x: 0.18,
                y: 0.555,
            },
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.27,
                y: 0.595,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.39,
                y: 0.652,
            },
            {
                x: 0.43,
                y: 0.678,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await waitForNoShapeSelectionUi(page);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 3);
        const postSaveState = await getManagedShapeDebugState(page);
        await waitForAllShapesEmbedded(page, 3);
        expect(postSaveState.shapes).toHaveLength(3);
        expect(postSaveState.shapes.every(shape => shape.source === 'embedded')).toBe(true);
        expect(postSaveState.shapes.every(shape => typeof shape.annotationId === 'string' && shape.annotationId.length > 0)).toBe(true);

        let annotationSummary = await waitForInkCountOnDisk(fixturePath, 3);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(3);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.24,
            y: 0.24,
        })).toBe(false);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.56,
            y: 0.34,
        })).toBe(false);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.34,
            y: 0.62,
        })).toBe(false);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.24,
            y: 0.24,
        });

        const afterFirstDelete = await getManagedShapeDebugState(page);
        expect(afterFirstDelete.deletedAnnotationIds).toHaveLength(1);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 1);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.56,
            y: 0.34,
        });

        const afterSecondDelete = await getManagedShapeDebugState(page);
        expect(afterSecondDelete.deletedAnnotationIds).toHaveLength(2);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
    });

    extendedIt('keeps later saved-stroke deletions stable when removing several saved strokes in a row', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-many-delete-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        const strokes = [
            {
                color: '#ef4444',
                hit: {
                    x: 0.18,
                    y: 0.2,
                },
                points: [
                    {
                        x: 0.14,
                        y: 0.17,
                    },
                    {
                        x: 0.18,
                        y: 0.2,
                    },
                    {
                        x: 0.24,
                        y: 0.24,
                    },
                ],
            },
            {
                color: '#22c55e',
                hit: {
                    x: 0.34,
                    y: 0.3,
                },
                points: [
                    {
                        x: 0.3,
                        y: 0.27,
                    },
                    {
                        x: 0.34,
                        y: 0.3,
                    },
                    {
                        x: 0.4,
                        y: 0.35,
                    },
                ],
            },
            {
                color: '#3b82f6',
                hit: {
                    x: 0.54,
                    y: 0.38,
                },
                points: [
                    {
                        x: 0.48,
                        y: 0.34,
                    },
                    {
                        x: 0.54,
                        y: 0.38,
                    },
                    {
                        x: 0.6,
                        y: 0.43,
                    },
                ],
            },
            {
                color: '#eab308',
                hit: {
                    x: 0.3,
                    y: 0.58,
                },
                points: [
                    {
                        x: 0.24,
                        y: 0.54,
                    },
                    {
                        x: 0.3,
                        y: 0.58,
                    },
                    {
                        x: 0.36,
                        y: 0.63,
                    },
                ],
            },
            {
                color: '#8b5cf6',
                hit: {
                    x: 0.62,
                    y: 0.66,
                },
                points: [
                    {
                        x: 0.56,
                        y: 0.61,
                    },
                    {
                        x: 0.62,
                        y: 0.66,
                    },
                    {
                        x: 0.69,
                        y: 0.71,
                    },
                ],
            },
        ] as const;

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        for (const stroke of strokes) {
            await setAnnotationColor(page, stroke.color);
            await dragInkStroke(page, stroke.points);
        }

        await waitForShapeCount(page, strokes.length);
        await waitForNoShapeSelectionUi(page);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, strokes.length);
        await waitForAllShapesEmbedded(page, strokes.length);

        let annotationSummary = await waitForInkCountOnDisk(fixturePath, strokes.length);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(strokes.length);

        for (let index = 0; index < strokes.length - 1; index += 1) {
            const stroke = strokes[index]!;
            await clickPagePoint(page, stroke.hit);
            await deleteSelectedShape(page);
            await waitForShapeCount(page, strokes.length - index - 1);
            await waitForNoVisibleInkAtPoint(page, stroke.hit);

            const stateAfterDelete = await getManagedShapeDebugState(page);
            expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(index + 1);
        }

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
    });

    extendedIt('keeps deleting the second saved stroke stable after deleting and saving the first saved stroke', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-first-then-second-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 3);
        await waitForAllShapesEmbedded(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);
        await waitForAllShapesEmbedded(page, 2);
        let annotationSummary = await waitForInkCountOnDisk(fixturePath, 2);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        const stateAfterSecondClick = await expectAnyManagedShapeSelected(page);
        await deleteSelectedShape(page);
        try {
            await waitForShapeCount(page, 1);
        } catch (error) {
            const [
                managedShapeState,
                toolbarState,
                greenCanvasGhostVisible,
                pointInteractionState,
            ] = await Promise.all([
                getManagedShapeDebugState(page),
                getToolbarSaveDebugState(page),
                hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
                    x: 0.56,
                    y: 0.34,
                }),
                getPointInteractionDebugState(page, {
                    x: 0.56,
                    y: 0.34,
                }),
            ]);
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `stateAfterSecondClick=${JSON.stringify(stateAfterSecondClick)}`,
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
                `toolbarState=${JSON.stringify(toolbarState)}`,
                `greenCanvasGhostVisible=${JSON.stringify(greenCanvasGhostVisible)}`,
                `pointInteractionState=${JSON.stringify(pointInteractionState)}`,
            ].join('\n'));
        }
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);
        annotationSummary = await readPdfAnnotationSummary(fixturePath);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(2);
    });

    extendedIt('keeps the popup-delete path stable after saving via the visible toolbar button', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }
        await page.setViewport({
            width: 1600,
            height: 1000,
        });

        const fixturePath = await createBlankFixturePdf(`phase1-draw-toolbar-popup-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaToolbarButton(page);
        await waitForShapeCount(page, 3);
        await waitForAllShapesEmbedded(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaToolbarButton(page);
        await waitForShapeCount(page, 2);
        await waitForAllShapesEmbedded(page, 2);
        let annotationSummary = await waitForInkCountOnDisk(fixturePath, 2);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await expectAnyManagedShapeSelected(page);
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 1);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);
        annotationSummary = await readPdfAnnotationSummary(fixturePath);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(2);
    });

    extendedIt('keeps the popup-delete path stable after saving through the workspace save hook', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-hook-popup-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 3);
        await waitForAllShapesEmbedded(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);
        await waitForAllShapesEmbedded(page, 2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await expectAnyManagedShapeSelected(page);
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 1);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);
    });

    extendedIt('keeps deleting the second saved stroke stable when the second delete happens immediately after saving the first delete', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-immediate-second-delete-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await expectAnyManagedShapeSelected(page);
        await deleteSelectedShape(page);
        try {
            await waitForShapeCount(page, 1);
        } catch (error) {
            const [
                managedShapeState,
                toolbarState,
                greenCanvasGhostVisible,
            ] = await Promise.all([
                getManagedShapeDebugState(page),
                getToolbarSaveDebugState(page),
                hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
                    x: 0.56,
                    y: 0.34,
                }),
            ]);
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
                `toolbarState=${JSON.stringify(toolbarState)}`,
                `greenCanvasGhostVisible=${JSON.stringify(greenCanvasGhostVisible)}`,
            ].join('\n'));
        }
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);
    });

    extendedIt('keeps shapes fully managed when one local stroke is deleted before the first save and another is deleted right after that save', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-delete-before-first-save-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        const stateAfterLocalDelete = await getManagedShapeDebugState(page);
        expect(stateAfterLocalDelete.deletedAnnotationIds).toEqual([]);
        expect(stateAfterLocalDelete.shapes).toHaveLength(2);
        expect(stateAfterLocalDelete.shapes.every(shape => shape.source === 'local')).toBe(true);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);
        await waitForAllShapesEmbedded(page, 2);

        const postFirstSaveState = await getManagedShapeDebugState(page);
        expect(postFirstSaveState.shapes).toHaveLength(2);
        expect(postFirstSaveState.shapes.every(shape => shape.source === 'embedded')).toBe(true);
        expect(postFirstSaveState.shapes.every(shape => typeof shape.annotationId === 'string' && shape.annotationId.length > 0)).toBe(true);

        let toolbarState = await getToolbarSaveDebugState(page);
        expect(toolbarState.activeTabDirty).toBe(false);
        if (toolbarState.toolbarSnapshot) {
            expect(toolbarState.toolbarSnapshot).toMatchObject({ canSave: false });
        }

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await expectAnyManagedShapeSelected(page);
        await deleteSelectedShape(page);
        try {
            await waitForShapeCount(page, 1);
        } catch (error) {
            const [
                managedShapeState,
                latestToolbarState,
                greenCanvasGhostVisible,
            ] = await Promise.all([
                getManagedShapeDebugState(page),
                getToolbarSaveDebugState(page),
                hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
                    x: 0.56,
                    y: 0.34,
                }),
            ]);
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
                `toolbarState=${JSON.stringify(latestToolbarState)}`,
                `greenCanvasGhostVisible=${JSON.stringify(greenCanvasGhostVisible)}`,
            ].join('\n'));
        }
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        const stateAfterSecondDelete = await getManagedShapeDebugState(page);
        expect(stateAfterSecondDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        await waitForAllShapesEmbedded(page, 1);

        const annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);

        toolbarState = await getToolbarSaveDebugState(page);
        expect(toolbarState.activeTabDirty).toBe(false);
        if (toolbarState.toolbarSnapshot) {
            expect(toolbarState.toolbarSnapshot).toMatchObject({ canSave: false });
        }
    });

    extendedIt('keeps the popup-delete path stable when the second delete happens immediately after a toolbar save', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }
        await page.setViewport({
            width: 1600,
            height: 1000,
        });

        const fixturePath = await createBlankFixturePdf(`phase1-draw-toolbar-popup-immediate-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaToolbarButton(page);
        await waitForShapeCount(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaToolbarButton(page);
        await waitForShapeCount(page, 2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await expectAnyManagedShapeSelected(page);
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 1);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);
    });

    extendedIt('keeps the popup-delete path stable when the second delete happens immediately after a save handle round-trip', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-popup-immediate-save-handle-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await expectAnyManagedShapeSelected(page);
        await deleteSelectedShapeViaPropertiesPopup(page);
        await waitForShapeCount(page, 1);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);
    });

    extendedIt('keeps deleting saved strokes stable across multiple save rounds', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-multi-round-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        const rounds = [
            [
                {
                    color: '#ef4444',
                    hit: {
                        x: 0.18,
                        y: 0.2,
                    },
                    points: [
                        {
                            x: 0.14,
                            y: 0.17,
                        },
                        {
                            x: 0.18,
                            y: 0.2,
                        },
                        {
                            x: 0.24,
                            y: 0.24,
                        },
                    ],
                },
                {
                    color: '#22c55e',
                    hit: {
                        x: 0.34,
                        y: 0.3,
                    },
                    points: [
                        {
                            x: 0.3,
                            y: 0.27,
                        },
                        {
                            x: 0.34,
                            y: 0.3,
                        },
                        {
                            x: 0.4,
                            y: 0.35,
                        },
                    ],
                },
                {
                    color: '#3b82f6',
                    hit: {
                        x: 0.54,
                        y: 0.38,
                    },
                    points: [
                        {
                            x: 0.48,
                            y: 0.34,
                        },
                        {
                            x: 0.54,
                            y: 0.38,
                        },
                        {
                            x: 0.6,
                            y: 0.43,
                        },
                    ],
                },
            ],
            [
                {
                    color: '#eab308',
                    hit: {
                        x: 0.28,
                        y: 0.56,
                    },
                    points: [
                        {
                            x: 0.23,
                            y: 0.52,
                        },
                        {
                            x: 0.28,
                            y: 0.56,
                        },
                        {
                            x: 0.34,
                            y: 0.61,
                        },
                    ],
                },
                {
                    color: '#8b5cf6',
                    hit: {
                        x: 0.5,
                        y: 0.6,
                    },
                    points: [
                        {
                            x: 0.45,
                            y: 0.56,
                        },
                        {
                            x: 0.5,
                            y: 0.6,
                        },
                        {
                            x: 0.56,
                            y: 0.65,
                        },
                    ],
                },
                {
                    color: '#f59e0b',
                    hit: {
                        x: 0.7,
                        y: 0.67,
                    },
                    points: [
                        {
                            x: 0.64,
                            y: 0.62,
                        },
                        {
                            x: 0.7,
                            y: 0.67,
                        },
                        {
                            x: 0.76,
                            y: 0.72,
                        },
                    ],
                },
            ],
            [
                {
                    color: '#06b6d4',
                    hit: {
                        x: 0.16,
                        y: 0.14,
                    },
                    points: [
                        {
                            x: 0.12,
                            y: 0.1,
                        },
                        {
                            x: 0.16,
                            y: 0.14,
                        },
                        {
                            x: 0.22,
                            y: 0.19,
                        },
                    ],
                },
                {
                    color: '#ec4899',
                    hit: {
                        x: 0.44,
                        y: 0.18,
                    },
                    points: [
                        {
                            x: 0.39,
                            y: 0.14,
                        },
                        {
                            x: 0.44,
                            y: 0.18,
                        },
                        {
                            x: 0.5,
                            y: 0.23,
                        },
                    ],
                },
                {
                    color: '#111827',
                    hit: {
                        x: 0.7,
                        y: 0.22,
                    },
                    points: [
                        {
                            x: 0.64,
                            y: 0.18,
                        },
                        {
                            x: 0.7,
                            y: 0.22,
                        },
                        {
                            x: 0.76,
                            y: 0.26,
                        },
                    ],
                },
            ],
        ] as const;

        let expectedInkCount = 0;
        let expectedDeletedCount = 0;

        for (const round of rounds) {
            await clickAnnotationTool(page, 'Draw');
            await waitForActiveColorIndicator(page);

            for (const stroke of round) {
                await setAnnotationColor(page, stroke.color);
                await dragInkStroke(page, stroke.points);
            }

            expectedInkCount += round.length;
            await waitForShapeCount(page, expectedInkCount);
            await waitForNoShapeSelectionUi(page);

            await saveViaWindowHandle(page);
            await waitForShapeCount(page, expectedInkCount);
            await waitForAllShapesEmbedded(page, expectedInkCount);

            let annotationSummary = await waitForInkCountOnDisk(fixturePath, expectedInkCount);
            expect(annotationSummary.bySubtype.Ink ?? 0).toBe(expectedInkCount);

            for (const stroke of round.slice(0, 2)) {
                await clickPagePoint(page, stroke.hit);
                await deleteSelectedShape(page);
                expectedInkCount -= 1;
                expectedDeletedCount += 1;
                await waitForShapeCount(page, expectedInkCount);
                await waitForNoVisibleInkAtPoint(page, stroke.hit);

                const stateAfterDelete = await getManagedShapeDebugState(page);
                expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(expectedDeletedCount);
            }

            await saveViaWindowHandle(page);
            await waitForShapeCount(page, expectedInkCount);
            annotationSummary = await waitForInkCountOnDisk(fixturePath, expectedInkCount);
            expect(annotationSummary.bySubtype.Ink ?? 0).toBe(expectedInkCount);

            expectedDeletedCount = 0;
        }
    });

    extendedIt('allows deleting a saved stroke immediately after save without leaving a ghost layer', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-immediate-delete-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2, 
            },
            {
                x: 0.24,
                y: 0.24, 
            },
            {
                x: 0.31,
                y: 0.3, 
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28, 
            },
            {
                x: 0.56,
                y: 0.34, 
            },
            {
                x: 0.66,
                y: 0.42, 
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58, 
            },
            {
                x: 0.34,
                y: 0.62, 
            },
            {
                x: 0.46,
                y: 0.7, 
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);

        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.24,
            y: 0.24,
        });
        const immediateAfterDeleteState = await getManagedShapeDebugState(page);
        expect(immediateAfterDeleteState.deletedAnnotationIds).toHaveLength(1);
    });

    extendedIt('allows deleting a preexisting saved stroke after reopening the file without leaving a ghost layer', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-reopen-delete-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2, 
            },
            {
                x: 0.24,
                y: 0.24, 
            },
            {
                x: 0.31,
                y: 0.3, 
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28, 
            },
            {
                x: 0.56,
                y: 0.34, 
            },
            {
                x: 0.66,
                y: 0.42, 
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58, 
            },
            {
                x: 0.34,
                y: 0.62, 
            },
            {
                x: 0.46,
                y: 0.7, 
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        expect(await hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
            x: 0.24,
            y: 0.24,
        })).toBe(false);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);

        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoint(page, {
            x: 0.24,
            y: 0.24,
        });
        const reopenAfterDeleteState = await getManagedShapeDebugState(page);
        expect(reopenAfterDeleteState.deletedAnnotationIds).toHaveLength(1);
    });

    extendedIt('keeps deleting saved survivors stable across successive save cycles', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-draw-successive-delete-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);

        await setAnnotationColor(page, '#ef4444');
        await dragInkStroke(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await setAnnotationColor(page, '#22c55e');
        await dragInkStroke(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);

        await setAnnotationColor(page, '#3b82f6');
        await dragInkStroke(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await waitForShapeCount(page, 3);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 3);
        await waitForAllShapesEmbedded(page, 3);

        await clickPagePoint(page, {
            x: 0.24,
            y: 0.24,
        });
        await deleteSelectedShape(page);
        await waitForShapeCount(page, 2);
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.18,
                y: 0.2,
            },
            {
                x: 0.24,
                y: 0.24,
            },
            {
                x: 0.31,
                y: 0.3,
            },
        ]);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);
        await waitForAllShapesEmbedded(page, 2);
        let annotationSummary = await waitForInkCountOnDisk(fixturePath, 2);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(2);

        await clickPagePoint(page, {
            x: 0.34,
            y: 0.62,
        });
        await deleteSelectedShape(page);
        try {
            await waitForShapeCount(page, 1);
        } catch (error) {
            const [
                managedShapeState,
                toolbarState,
                greenCanvasGhostVisible,
            ] = await Promise.all([
                getManagedShapeDebugState(page),
                getToolbarSaveDebugState(page),
                hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
                    x: 0.34,
                    y: 0.62,
                }),
            ]);
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
                `toolbarState=${JSON.stringify(toolbarState)}`,
                `greenCanvasGhostVisible=${JSON.stringify(greenCanvasGhostVisible)}`,
            ].join('\n'));
        }
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.22,
                y: 0.58,
            },
            {
                x: 0.34,
                y: 0.62,
            },
            {
                x: 0.46,
                y: 0.7,
            },
        ]);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        await waitForAllShapesEmbedded(page, 1);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);

        await clickAnnotationTool(page, 'Draw');
        await waitForActiveColorIndicator(page);
        await setAnnotationColor(page, '#f59e0b');
        await dragInkStroke(page, [
            {
                x: 0.54,
                y: 0.56,
            },
            {
                x: 0.65,
                y: 0.64,
            },
            {
                x: 0.74,
                y: 0.72,
            },
        ]);

        await waitForShapeCount(page, 2);
        await waitForNoShapeSelectionUi(page);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 2);
        await waitForAllShapesEmbedded(page, 2);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 2);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(2);

        await clickPagePoint(page, {
            x: 0.56,
            y: 0.34,
        });
        await deleteSelectedShape(page);
        try {
            await waitForShapeCount(page, 1);
        } catch (error) {
            const [
                managedShapeState,
                toolbarState,
                greenCanvasGhostVisible,
            ] = await Promise.all([
                getManagedShapeDebugState(page),
                getToolbarSaveDebugState(page),
                hasVisibleCanvasInkAtPointWithOverlayHidden(page, {
                    x: 0.56,
                    y: 0.34,
                }),
            ]);
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
                `toolbarState=${JSON.stringify(toolbarState)}`,
                `greenCanvasGhostVisible=${JSON.stringify(greenCanvasGhostVisible)}`,
            ].join('\n'));
        }
        await waitForNoVisibleInkAtPoints(page, [
            {
                x: 0.46,
                y: 0.28,
            },
            {
                x: 0.56,
                y: 0.34,
            },
            {
                x: 0.66,
                y: 0.42,
            },
        ]);
    });

    extendedIt('keeps deleting the second saved line stable after deleting and saving the first saved line', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

        const fixturePath = await createBlankFixturePdf(`phase1-line-first-then-second-${Date.now()}.pdf`, 1);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);

        await clickAnnotationTool(page, 'Line');
        await waitForActiveColorIndicator(page);

        const lines = [
            {
                color: '#ef4444',
                start: {
                    x: 0.18,
                    y: 0.18,
                },
                end: {
                    x: 0.38,
                    y: 0.34,
                },
                hit: {
                    x: 0.28,
                    y: 0.26,
                },
            },
            {
                color: '#22c55e',
                start: {
                    x: 0.52,
                    y: 0.2,
                },
                end: {
                    x: 0.52,
                    y: 0.56,
                },
                hit: {
                    x: 0.52,
                    y: 0.38,
                },
            },
            {
                color: '#3b82f6',
                start: {
                    x: 0.2,
                    y: 0.62,
                },
                end: {
                    x: 0.44,
                    y: 0.78,
                },
                hit: {
                    x: 0.32,
                    y: 0.7,
                },
            },
        ];

        for (const line of lines) {
            await setAnnotationColor(page, line.color);
            await dragLineSegment(page, {
                start: line.start,
                end: line.end,
            });
        }

        await waitForShapeCount(page, lines.length);
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, lines.length);
        await waitForAllShapesEmbedded(page, lines.length);
        let annotationSummary = await waitForLineCountOnDisk(fixturePath, lines.length);
        expect(annotationSummary.bySubtype.Line ?? 0).toBe(lines.length);

        await clickPagePoint(page, lines[0]!.hit);
        await deleteSelectedShape(page);
        await waitForShapeCount(page, lines.length - 1);
        await waitForNoVisibleInkAtPoints(page, [
            lines[0]!.start,
            lines[0]!.hit,
            lines[0]!.end,
        ]);

        let stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, lines.length - 1);
        await waitForAllShapesEmbedded(page, lines.length - 1);
        annotationSummary = await waitForLineCountOnDisk(fixturePath, lines.length - 1);
        expect(annotationSummary.bySubtype.Line ?? 0).toBe(lines.length - 1);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.shapes).toHaveLength(lines.length - 1);
        expect(stateAfterDelete.shapes.every(shape => shape.type === 'line' && shape.source === 'embedded')).toBe(true);

        await clickPagePoint(page, lines[1]!.hit);
        await deleteSelectedShape(page);
        try {
            await waitForShapeCount(page, 1);
        } catch (error) {
            const [
                managedShapeState,
                toolbarState,
                secondLineGhostVisible,
            ] = await Promise.all([
                getManagedShapeDebugState(page),
                getToolbarSaveDebugState(page),
                hasVisibleCanvasInkAtPointWithOverlayHidden(page, lines[1]!.hit),
            ]);
            throw new Error([
                error instanceof Error ? error.message : String(error),
                `managedShapeState=${JSON.stringify(managedShapeState)}`,
                `toolbarState=${JSON.stringify(toolbarState)}`,
                `secondLineGhostVisible=${JSON.stringify(secondLineGhostVisible)}`,
            ].join('\n'));
        }
        await waitForNoVisibleInkAtPoints(page, [
            lines[1]!.start,
            lines[1]!.hit,
            lines[1]!.end,
        ]);

        stateAfterDelete = await getManagedShapeDebugState(page);
        expect(stateAfterDelete.deletedAnnotationIds).toHaveLength(1);

        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        await waitForAllShapesEmbedded(page, 1);
        annotationSummary = await waitForLineCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Line ?? 0).toBe(1);

        const toolbarState = await getToolbarSaveDebugState(page);
        expect(toolbarState.activeTabDirty).toBe(false);
    });
});
