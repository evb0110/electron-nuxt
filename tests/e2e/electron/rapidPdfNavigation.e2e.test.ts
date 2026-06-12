import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    resolvePathFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/getE2EWindow';
import { openPdfInApp } from '@tests/e2e/electron/helpers/viewerCore';
import { callWorkspaceCommand } from '@tests/e2e/electron/helpers/workspaceExpose';
import type { IPdfRenderTraceEntry } from '@app/utils/pdfRenderTrace';

const PAGE_JUMP_PDF_ENV_VAR = 'EVB_E2E_PAGE_JUMP_PDF_PATH';
const PAGE_JUMP_REQUIRE_ENV_VAR = 'EVB_E2E_REQUIRE_PAGE_JUMP_FIXTURE';
const PAGE_JUMP_PDF_PATH = process.env[PAGE_JUMP_PDF_ENV_VAR]?.length
    ? process.env[PAGE_JUMP_PDF_ENV_VAR]
    : resolve(process.cwd(), '.devkit', 'manual-pdf-fixtures', 'page-jump-source.pdf');
const TARGET_PAGE = 100;
const TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-page-100-jump-trace.json',
);
const NEXT_PREV_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-next-prev-10-to-7-trace.json',
);
const RAPID_NEXT_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-rapid-next-to-21-trace.json',
);
const pageJumpFixture = resolvePathFixtureAvailability({
    path: PAGE_JUMP_PDF_PATH,
    label: 'page-jump PDF',
    requiredEnvVar: PAGE_JUMP_REQUIRE_ENV_VAR,
});
const pageJumpDescribe = selectFixtureDescribe(describe, pageJumpFixture);

interface IVisiblePageState {
    page: number | null;
    renderedClass: boolean;
    hasCanvas: boolean;
    canvasCount: number;
    textSpanCount: number;
    markerCount: number;
    linkOverlayCount: number;
    shapeOverlayCount: number;
    visibleShapeCount: number;
    annotationEditorNodeCount: number;
    skeletonDisplay: string | null;
    rectTop: number;
    rectHeight: number;
}

interface IPageButtonState {
    label: string;
    disabled: boolean;
    visible: boolean;
}

function writeTraceArtifact(payload: unknown, outputPath = TRACE_OUTPUT_PATH) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function enableBufferedPdfTrace(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        localStorage.setItem('evb-viewer:pdf-render-trace', '1');
        localStorage.removeItem('evb-viewer:pdf-render-trace-console');
        const traceWindow = window as IE2EWindow & {
            __pdfRenderTrace?: boolean;
            __pdfRenderTraceConsole?: boolean;
            __clearPdfRenderTrace?: () => void;
        };
        traceWindow.__pdfRenderTrace = true;
        traceWindow.__pdfRenderTraceConsole = false;
        traceWindow.__clearPdfRenderTrace?.();
    });
}

async function collectNavigationControlState(session: IElectronE2ESession) {
    return session.page.evaluate(() => ({
        pageControlsText: document.querySelector<HTMLElement>('.page-controls')?.innerText ?? '',
        pageButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .map((button): IPageButtonState => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return {
                    label: button.getAttribute('aria-label') ?? '',
                    disabled: button.disabled,
                    visible: (
                        rect.width > 0
                        && rect.height > 0
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                    ),
                };
            }),
    }));
}

async function collectVisiblePageState(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.pdf-viewer-viewport, .pdfViewer, #pdf-viewer');
        const viewportRect = viewport?.getBoundingClientRect() ?? {
            top: 0,
            bottom: window.innerHeight,
        };
        return Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
            .map((container): IVisiblePageState => {
                const rect = container.getBoundingClientRect();
                const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
                return {
                    page: Number(container.dataset.page) || null,
                    renderedClass: container.classList.contains('page_container--rendered'),
                    hasCanvas: Boolean(container.querySelector('.page_canvas canvas')),
                    canvasCount: container.querySelectorAll('.page_canvas canvas').length,
                    textSpanCount: container.querySelectorAll('.text-layer span, .textLayer span').length,
                    markerCount: container.querySelectorAll('.pdf-comment-marker-button').length,
                    linkOverlayCount: container.querySelectorAll('.pdf-link-overlay').length,
                    shapeOverlayCount: container.querySelectorAll('.pdf-shape-overlay').length,
                    visibleShapeCount: container.querySelectorAll('.pdf-shape-overlay > g:not(.is-drawing)').length,
                    annotationEditorNodeCount: container.querySelectorAll('.annotationEditorLayer *, .annotation-editor-layer *').length,
                    skeletonDisplay: skeleton?.style.display ?? null,
                    rectTop: rect.top,
                    rectHeight: rect.height,
                };
            })
            .filter(page => {
                const bottom = page.rectTop + page.rectHeight;
                return bottom >= viewportRect.top && page.rectTop <= viewportRect.bottom;
            });
    });
}

async function collectTrace(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const traceWindow = window as IE2EWindow & { __getPdfRenderTrace?: () => IPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

async function clickPageNavigationButton(session: IElectronE2ESession, label: string) {
    await session.page.waitForFunction((targetLabel: string) => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .some((candidate) => {
                const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    (ariaLabel === targetLabel || ariaLabel.startsWith(`${targetLabel} (`))
                    && !candidate.disabled
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                );
            });
    }, { timeout: 12_000 }, label);

    const clicked = await session.page.evaluate((targetLabel: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .find((candidate) => {
                const ariaLabel = candidate.getAttribute('aria-label')?.trim() ?? '';
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    (ariaLabel === targetLabel || ariaLabel.startsWith(`${targetLabel} (`))
                    && !candidate.disabled
                    && candidate.getAttribute('aria-disabled') !== 'true'
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                );
            });
        button?.click();
        return Boolean(button);
    }, label);

    if (!clicked) {
        throw new Error(`Unable to find enabled page navigation button: ${label}`);
    }
}

async function waitForToolbarCurrentPage(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((targetPageNumber: number) => {
        return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .some((element) => element.textContent?.trim() === String(targetPageNumber));
    }, { timeout: 10_000 }, pageNumber);
}

async function waitForVisiblePageCanvas(session: IElectronE2ESession, pageNumber: number, timeout = 10_000) {
    return session.page.waitForFunction((targetPageNumber: number) => {
        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`);
        const rect = container?.getBoundingClientRect();
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && container.querySelector('.page_canvas canvas')
            && rect
            && rect.bottom > 0
            && rect.top < window.innerHeight,
        );
    }, { timeout }, pageNumber)
        .then(() => true)
        .catch(() => false);
}

async function jumpToPageAndWaitForCanvas(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 15_000 });

    const workspaceJump = await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber]);

    if (workspaceJump.called) {
        return;
    }

    await callWorkspaceCommand(session.page, 'scrollToPage', [pageNumber]);

    const canvasMounted = await session.page.waitForFunction((targetPageNumber: number) => {
        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`);
        const rect = container?.getBoundingClientRect();
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && container.querySelector('.page_canvas canvas')
            && rect
            && rect.bottom > 0
            && rect.top < window.innerHeight,
        );
    }, { timeout: 8_000 }, pageNumber)
        .then(() => true)
        .catch(() => false);

    if (canvasMounted) {
        return;
    }

    const displayPoint = await session.page.evaluate(() => {
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
        throw new Error(`Unable to find the visible page control for page ${pageNumber}`);
    }

    await session.page.mouse.click(displayPoint.x, displayPoint.y);
    await session.page.waitForFunction(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        return Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .some(isVisibleElement);
    }, { timeout: 15_000 });

    const inputPoint = await session.page.evaluate(() => {
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };

        const input = Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .find(isVisibleElement);
        if (!input) {
            return null;
        }

        const rect = input.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });

    if (!inputPoint) {
        throw new Error(`Unable to find the visible page input for page ${pageNumber}`);
    }

    await session.page.mouse.click(inputPoint.x, inputPoint.y, { count: 3 });
    await session.page.keyboard.type(String(pageNumber));
    await session.page.keyboard.press('Enter');

    await delay(1_000);
}

pageJumpDescribe('Electron E2E - PDF Page Jump Rendering', () => {
    let pageJumpReady = false;

    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-pdf-page-jump-${Date.now()}`,
        timeoutMs: 90_000,
    });

    it('opens the page-jump PDF for navigation checks', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        await enableBufferedPdfTrace(session);
        await openPdfInApp(session.page, PAGE_JUMP_PDF_PATH, 45_000);
        pageJumpReady = true;
    }, 90_000);

    it('renders page 7 after toolbar next navigation to page 10 and previous navigation back', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady) {
            return;
        }

        let targetCanvasMounted = false;
        let visiblePages: IVisiblePageState[] = [];
        let navigationControls: Awaited<ReturnType<typeof collectNavigationControlState>> | null = null;
        let trace: IPdfRenderTraceEntry[] = [];

        try {
            await jumpToPageAndWaitForCanvas(session, 1);
            await waitForToolbarCurrentPage(session, 1);

            for (let pageNumber = 2; pageNumber <= 10; pageNumber += 1) {
                await clickPageNavigationButton(session, 'Next Page');
                await waitForToolbarCurrentPage(session, pageNumber);
                await delay(150);
            }

            for (let pageNumber = 9; pageNumber >= 7; pageNumber -= 1) {
                await clickPageNavigationButton(session, 'Previous Page');
                await waitForToolbarCurrentPage(session, pageNumber);
                await delay(150);
            }

            targetCanvasMounted = await waitForVisiblePageCanvas(session, 7, 12_000);
            visiblePages = await collectVisiblePageState(session);
            navigationControls = await collectNavigationControlState(session);
            trace = await collectTrace(session);
        } finally {
            if (visiblePages.length === 0) {
                visiblePages = await collectVisiblePageState(session).catch(() => []);
            }
            navigationControls ??= await collectNavigationControlState(session).catch(() => null);
            if (trace.length === 0) {
                trace = await collectTrace(session).catch(() => []);
            }
            const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
            const targetPageState = visiblePages.find(page => page.page === 7) ?? null;
            writeTraceArtifact({
                pdfPath: PAGE_JUMP_PDF_PATH,
                scenario: 'toolbar-next-to-10-prev-to-7',
                navigationControls,
                visiblePages,
                targetPageState,
                targetCanvasMounted,
                blankVisiblePages,
                trace,
            }, NEXT_PREV_TRACE_OUTPUT_PATH);
        }

        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === 7) ?? null;

        expect(targetCanvasMounted).toBe(true);
        expect(targetPageState).not.toBeNull();
        expect(blankVisiblePages).toEqual([]);
    }, 70_000);

    it('renders the final page after twenty rapid next-page clicks', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForToolbarCurrentPage(session, 1);

        for (let step = 0; step < 20; step += 1) {
            await clickPageNavigationButton(session, 'Next Page');
        }
        await waitForToolbarCurrentPage(session, 21);

        const targetCanvasMounted = await waitForVisiblePageCanvas(session, 21, 14_000);
        const visiblePages = await collectVisiblePageState(session);
        const navigationControls = await collectNavigationControlState(session);
        const trace = await collectTrace(session);
        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === 21) ?? null;
        writeTraceArtifact({
            pdfPath: PAGE_JUMP_PDF_PATH,
            scenario: 'toolbar-rapid-next-to-21',
            navigationControls,
            visiblePages,
            targetPageState,
            targetCanvasMounted,
            blankVisiblePages,
            trace,
        }, RAPID_NEXT_TRACE_OUTPUT_PATH);

        expect(targetCanvasMounted).toBe(true);
        expect(targetPageState).not.toBeNull();
        expect(blankVisiblePages).toEqual([]);
    }, 80_000);

    it('keeps page overlays mounted after jumping to page 100', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady) {
            return;
        }

        await delay(5_000);
        await jumpToPageAndWaitForCanvas(session, TARGET_PAGE);
        await delay(6_000);

        const visiblePages = await collectVisiblePageState(session);
        const navigationControls = await collectNavigationControlState(session);
        const trace = await collectTrace(session);
        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === TARGET_PAGE) ?? null;
        writeTraceArtifact({
            pdfPath: PAGE_JUMP_PDF_PATH,
            targetPage: TARGET_PAGE,
            navigationControls,
            visiblePages,
            targetPageState,
            blankVisiblePages,
            trace,
        });

        expect(targetPageState).not.toBeNull();
        expect(blankVisiblePages).toEqual([]);
    }, 60_000);
});
