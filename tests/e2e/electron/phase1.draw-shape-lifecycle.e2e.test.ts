import type { Page } from 'puppeteer-core';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    createMultiPageTextFixturePdf,
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
    waitForPdfLoaded,
    waitForViewerInteractive,
} from './helpers/viewer-helpers';

async function waitForShapeCount(page: Page, expectedCount: number) {
    await waitForFunctionInPage(page, (count: number) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host')
            ?? null;
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
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host')
            ?? null;
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
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host')
            ?? null;
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
    const didActivateSelect = await evaluateInPage(page, () => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host')
            ?? null;
        const button = host?.querySelector<HTMLButtonElement>('.notes-panel .tool-button[data-tool="select"]') ?? null;
        if (!button) {
            return false;
        }
        button.click();
        return true;
    });
    if (!didActivateSelect) {
        throw new Error('Unable to activate the Select tool');
    }

    await waitForViewerInteractive(page);
    await waitForFunctionInPage(page, (targetPageNumber: number) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host')
            ?? null;
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-selection-enabled`) ?? null;
        return Boolean(overlay);
    }, { timeout: 10_000 }, pageNumber);

    const didClick = await evaluateInPage(page, ({
        targetPageNumber,
        ratioX,
        ratioY,
    }: {
        targetPageNumber: number;
        ratioX: number;
        ratioY: number;
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host')
            ?? null;
        const overlay = host?.querySelector<SVGElement>(`.page_container[data-page="${targetPageNumber}"] .pdf-shape-overlay.is-selection-enabled`) ?? null;
        if (!overlay) {
            return false;
        }

        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const clientX = rect.left + rect.width * ratioX;
        const clientY = rect.top + rect.height * ratioY;
        const eventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            clientX,
            clientY,
        };
        overlay.dispatchEvent(new PointerEvent('pointerdown', {
            ...eventInit,
            buttons: 1,
        }));
        overlay.dispatchEvent(new PointerEvent('pointerup', {
            ...eventInit,
            buttons: 0,
        }));
        overlay.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 0,
            clientX,
            clientY,
        }));
        return true;
    }, {
        targetPageNumber: pageNumber,
        ratioX: point.x,
        ratioY: point.y,
    });

    if (!didClick) {
        throw new Error('Unable to resolve click target for shape');
    }
}

async function deleteSelectedShape(page: Page) {
    await page.keyboard.press('Delete');
}

describe('Electron E2E - Phase 1 (Draw Shape Lifecycle)', () => {
    let session: IElectronE2ESession | null = null;
    let fixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-draw-shapes-${Date.now()}`);
        fixturePath = await createMultiPageTextFixturePdf(`phase1-draw-${Date.now()}.pdf`, 2);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('preserves repeated draw-save-delete-redraw cycles without ghost shapes', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 draw-shape session was not initialized');
        }

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
        await saveViaWindowHandle(page);
        await waitForShapeCount(page, 1);
        annotationSummary = await waitForInkCountOnDisk(fixturePath, 1);
        expect(annotationSummary.bySubtype.Ink ?? 0).toBe(1);
    });
});
