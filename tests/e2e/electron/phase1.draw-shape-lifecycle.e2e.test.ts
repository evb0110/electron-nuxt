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
} from './helpers/page-runtime';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/session-harness';
import {
    clickAnnotationTool,
    openPdfInApp,
    saveViaWindowHandle,
    setAnnotationColor,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from './helpers/viewer-helpers';

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

async function waitForInkCountOnDisk(filePath: string, expectedCount: number, timeoutMs = 10_000) {
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
        const summary = await readPdfAnnotationSummary(filePath);
        if ((summary.bySubtype.Ink ?? 0) === expectedCount) {
            return summary;
        }
        await delay(250);
    }

    return readPdfAnnotationSummary(filePath);
}

async function dragInkStroke(
    page: Page,
    points: Array<{
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
        ratios: Array<{
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
        ratios: points,
    });

    if (!didDraw) {
        throw new Error('Failed to dispatch ink stroke events');
    }
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

async function deleteSelectedShape(page: Page) {
    await page.keyboard.press('Delete');
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

        return !hasVisibleInk;
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
                    source?: string;
                    annotationId?: string | null;
                    stableKey?: string | null;
                }>;
                hasShapes?: {value?: boolean;} | boolean;
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
            domShapeCount: host?.querySelectorAll('.pdf-shape-overlay > g:not(.is-drawing)').length ?? 0,
            shapes: shapes.map(shape => ({
                id: shape.id,
                source: shape.source ?? null,
                annotationId: shape.annotationId ?? null,
                stableKey: shape.stableKey ?? null,
            })),
            deletedAnnotationIds: normalizedPdfViewerInstance?.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
            deletedStableKeys: normalizedPdfViewerInstance?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
            hiddenIds,
        };
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

    beforeEach(async () => {
        session = await startElectronE2ESession(`e2e-draw-shapes-${Date.now()}`);
    });

    afterEach(async () => {
        await session?.stop();
        session = null;
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
    });

    it('keeps multiple saved strokes fully managed after save so delete clears them visually before the next save', async () => {
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

    it('allows deleting a saved stroke immediately after save without leaving a ghost layer', async () => {
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

    it('allows deleting a preexisting saved stroke after reopening the file without leaving a ghost layer', async () => {
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
});
