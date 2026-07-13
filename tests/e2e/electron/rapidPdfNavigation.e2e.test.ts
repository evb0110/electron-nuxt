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
    createLargeScannedFixturePdf,
    resolvePathFixtureAvailability,
} from '@tests/e2e/electron/helpers/fixtures';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/getE2EWindow';
import { openPdfInApp } from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type { IPdfRenderTraceEntry } from '@app/utils/pdfRenderTrace';
import type { IEvbTestApi } from '@app/types/evbTestApi';
import { enablePdfDiagnosticSession } from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import {
    installCommittedSurfaceSampler,
    stopCommittedSurfaceSampler,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import {
    collectPdfVirtualizationSnapshot,
    findMissingVisualFrames,
    findPdfVirtualizationContractViolations,
    waitForAnimationFrames,
    waitForScannedFixturePageIdentity,
    waitForVisibleMountedPdfCanvases,
    wheelPdfViewportAndWaitForSettlement,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';

const PAGE_JUMP_PDF_ENV_VAR = 'EVB_E2E_PAGE_JUMP_PDF_PATH';
const PAGE_JUMP_PDF_OVERRIDE = process.env[PAGE_JUMP_PDF_ENV_VAR]?.trim() ?? null;
const GENERATED_PAGE_JUMP_PAGE_COUNT = 431;
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
const CONTINUOUS_SCROLL_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-continuous-scroll-virtualization-trace.json',
);
const NEXT_FIT_WIDTH_TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-next-fit-width-visual-trace.json',
);
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
    computedVisible: boolean;
    topmost: boolean;
}

interface IPageButtonState {
    label: string;
    disabled: boolean;
    visible: boolean;
}

interface IRapidNavigationProbeWindow { __evbTestApi?: IEvbTestApi }

function writeTraceArtifact(payload: unknown, outputPath = TRACE_OUTPUT_PATH) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function resolvePageJumpPdfPath() {
    if (PAGE_JUMP_PDF_OVERRIDE) {
        const override = resolvePathFixtureAvailability({
            path: PAGE_JUMP_PDF_OVERRIDE,
            label: 'page-jump PDF override',
            requiredEnvVar: PAGE_JUMP_PDF_ENV_VAR,
        });
        if (!override.path) {
            throw new Error(override.reason);
        }
        return override.path;
    }

    return createLargeScannedFixturePdf(
        `page-jump-source-${Date.now()}.pdf`,
        GENERATED_PAGE_JUMP_PAGE_COUNT,
        0,
    );
}

async function enableBufferedPdfTrace(session: IElectronE2ESession) {
    await enablePdfDiagnosticSession(session.page, {render: true});
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
            left: 0,
            right: window.innerWidth,
            top: 0,
            bottom: window.innerHeight,
        };
        return Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
            .map((container): IVisiblePageState => {
                const rect = container.getBoundingClientRect();
                const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
                const style = window.getComputedStyle(container);
                const intersectionLeft = Math.max(viewportRect.left, rect.left);
                const intersectionRight = Math.min(viewportRect.right, rect.right);
                const intersectionTop = Math.max(viewportRect.top, rect.top);
                const intersectionBottom = Math.min(viewportRect.bottom, rect.bottom);
                const topmost = intersectionRight > intersectionLeft && intersectionBottom > intersectionTop
                    ? document.elementFromPoint(
                        intersectionLeft + ((intersectionRight - intersectionLeft) / 2),
                        intersectionTop + ((intersectionBottom - intersectionTop) / 2),
                    )
                    : null;
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
                    computedVisible: style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0,
                    topmost: topmost?.closest('.page_container') === container,
                };
            })
            .filter(page => {
                const bottom = page.rectTop + page.rectHeight;
                return page.computedVisible
                    && bottom >= viewportRect.top
                    && page.rectTop <= viewportRect.bottom;
            });
    });
}

async function collectVirtualScrollGeometry(session: IElectronE2ESession, targetPage: number) {
    return session.page.evaluate((pageNumber) => {
        const viewport = document.querySelector<HTMLElement>('.pdf-viewer-viewport, .pdfViewer, #pdf-viewer');
        const target = document.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
        const targetRect = target?.getBoundingClientRect() ?? null;
        return {
            viewport: viewport ? {
                clientHeight: viewport.clientHeight,
                scrollHeight: viewport.scrollHeight,
                scrollTop: viewport.scrollTop,
            } : null,
            target: targetRect ? {
                offsetTop: target?.offsetTop ?? null,
                rectHeight: targetRect.height,
                rectTop: targetRect.top,
            } : null,
            spacers: Array.from(document.querySelectorAll<HTMLElement>('.pdf-viewer-virtual-spacer')).map((spacer) => {
                const rect = spacer.getBoundingClientRect();
                return {
                    computedHeight: window.getComputedStyle(spacer).height,
                    inlineHeight: spacer.style.height,
                    offsetHeight: spacer.offsetHeight,
                    rectHeight: rect.height,
                };
            }),
        };
    }, targetPage);
}

async function collectConsecutivePageGaps(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const pages = Array.from(document.querySelectorAll<HTMLElement>(
            '#pdf-viewer .page_container:not(.page_container--buffered)',
        )).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                bottom: rect.bottom,
                page: Number(element.dataset.page),
                top: rect.top,
            };
        }).filter(page => Number.isSafeInteger(page.page))
            .sort((left, right) => left.page - right.page);
        return pages.slice(1).flatMap((page, index) => {
            const previous = pages[index]!;
            return page.page === previous.page + 1
                ? [{
                    fromPage: previous.page,
                    gap: page.top - previous.bottom,
                    toPage: page.page,
                }]
                : [];
        });
    });
}

async function collectCommittedCanvasQuality(
    session: IElectronE2ESession,
    pageNumber: number,
    marker?: string,
) {
    return session.page.evaluate((input) => {
        const page = document.querySelector<HTMLElement>(
            `#pdf-viewer .page_container[data-page="${String(input.pageNumber)}"]`,
        );
        const canvas = page?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        if (!page || !canvas) {
            return null;
        }
        if (input.marker) {
            canvas.dataset.e2eCommittedCanvasMarker = input.marker;
        }
        const rect = canvas.getBoundingClientRect();
        const context = canvas.getContext('2d');
        let luminanceVariance = 0;
        if (context && canvas.width > 0 && canvas.height > 0) {
            const samples: number[] = [];
            for (let row = 1; row <= 8; row += 1) {
                for (let column = 1; column <= 8; column += 1) {
                    const x = Math.min(canvas.width - 1, Math.round((canvas.width * column) / 9));
                    const y = Math.min(canvas.height - 1, Math.round((canvas.height * row) / 9));
                    const pixel = context.getImageData(x, y, 1, 1).data;
                    samples.push((pixel[0]! * 0.2126) + (pixel[1]! * 0.7152) + (pixel[2]! * 0.0722));
                }
            }
            const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
            luminanceVariance = samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
                / samples.length;
        }
        return {
            backingHeight: canvas.height,
            backingScaleX: rect.width > 0 ? canvas.width / rect.width : 0,
            backingScaleY: rect.height > 0 ? canvas.height / rect.height : 0,
            backingWidth: canvas.width,
            cssHeight: rect.height,
            cssWidth: rect.width,
            luminanceVariance,
            marker: canvas.dataset.e2eCommittedCanvasMarker ?? '',
            rendered: page.classList.contains('page_container--rendered'),
            skeletonVisible: Array.from(page.querySelectorAll<HTMLElement>('.pdf-page-skeleton'))
                .some(skeleton => window.getComputedStyle(skeleton).display !== 'none'),
        };
    }, {
        marker,
        pageNumber,
    });
}

async function collectTrace(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const traceWindow = window as IE2EWindow & { __getPdfRenderTrace?: () => IPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

async function collectRapidNavigationDebug(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const probeWindow = window as Window & IRapidNavigationProbeWindow;
        return {
            activeToolbarSnapshot: probeWindow.__evbTestApi?.getActiveToolbarSnapshot?.() ?? null,
            toolbarPrimaryTexts: Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .map(element => element.textContent?.trim() ?? ''),
            workspaceDebugState: probeWindow.__evbTestApi?.collectWorkspaceDebugState?.() ?? null,
        };
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
        const isVisibleElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
        };
        return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .some((element) => {
                const controls = element.closest<HTMLElement>('.page-controls');
                return element.textContent?.trim() === String(targetPageNumber)
                    && isVisibleElement(controls ?? element);
            });
    }, { timeout: 10_000 }, pageNumber);
}

async function waitForVisiblePageCanvas(session: IElectronE2ESession, pageNumber: number, timeout = 10_000) {
    return session.page.waitForFunction((targetPageNumber: number) => {
        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPageNumber}"]`);
        const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        const viewerRect = viewer?.getBoundingClientRect();
        const rect = container?.getBoundingClientRect();
        if (!viewer || !viewerRect || !container || !rect || !canvas) {
            return false;
        }
        const left = Math.max(viewerRect.left, rect.left);
        const right = Math.min(viewerRect.right, rect.right);
        const top = Math.max(viewerRect.top, rect.top);
        const bottom = Math.min(viewerRect.bottom, rect.bottom);
        if (right <= left || bottom <= top) {
            return false;
        }
        const topmost = document.elementFromPoint(
            left + ((right - left) / 2),
            top + ((bottom - top) / 2),
        );
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && canvas.width > 0
            && canvas.height > 0
            && window.getComputedStyle(container).visibility !== 'hidden'
            && !container.classList.contains('page_container--buffered')
            && topmost?.closest('.page_container') === container,
        );
    }, { timeout }, pageNumber)
        .then(() => true)
        .catch(() => false);
}

async function jumpToPageAndWaitForCanvas(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 15_000 });

    const workspaceJump = await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber]);

    if (workspaceJump.called) {
        const canvasMounted = await waitForVisiblePageCanvas(session, pageNumber, 8_000);
        if (canvasMounted) {
            return;
        }
    }

    await callWorkspaceCommand(session.page, 'scrollToPage', [pageNumber]);

    const canvasMounted = await waitForVisiblePageCanvas(session, pageNumber, 8_000);

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

describe('Electron E2E - PDF Page Jump Rendering', () => {
    let pageJumpPdfPath: string | null = null;
    let pageJumpReady = false;

    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-pdf-page-jump-${Date.now()}`,
        timeoutMs: 180_000,
    });

    it('opens the page-jump PDF for navigation checks', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        pageJumpPdfPath = await resolvePageJumpPdfPath();
        await enableBufferedPdfTrace(session);
        await openPdfInApp(session.page, pageJumpPdfPath, 45_000);
        pageJumpReady = true;
    }, 90_000);

    it('renders page 7 after toolbar next navigation to page 10 and previous navigation back', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
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
                pdfPath: pageJumpPdfPath,
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
        expect(targetPageState?.topmost).toBe(true);
        expect(blankVisiblePages).toEqual([]);
    }, 70_000);

    it('renders the final page after twenty rapid next-page clicks', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        let targetCanvasMounted = false;
        let visiblePages: IVisiblePageState[] = [];
        let navigationControls: Awaited<ReturnType<typeof collectNavigationControlState>> | null = null;
        let rapidNavigationDebug: Awaited<ReturnType<typeof collectRapidNavigationDebug>> | null = null;
        let trace: IPdfRenderTraceEntry[] = [];
        let toolbarReachedTarget = false;
        let failureMessage: string | null = null;

        try {
            await jumpToPageAndWaitForCanvas(session, 1);
            await waitForToolbarCurrentPage(session, 1);

            for (let step = 0; step < 20; step += 1) {
                await clickPageNavigationButton(session, 'Next Page');
            }
            await waitForToolbarCurrentPage(session, 21);
            toolbarReachedTarget = true;

            targetCanvasMounted = await waitForVisiblePageCanvas(session, 21, 14_000);
            visiblePages = await collectVisiblePageState(session);
            navigationControls = await collectNavigationControlState(session);
            rapidNavigationDebug = await collectRapidNavigationDebug(session);
            trace = await collectTrace(session);
        } catch (error) {
            failureMessage = error instanceof Error
                ? error.message
                : String(error);
            throw error;
        } finally {
            if (visiblePages.length === 0) {
                visiblePages = await collectVisiblePageState(session).catch(() => []);
            }
            navigationControls ??= await collectNavigationControlState(session).catch(() => null);
            rapidNavigationDebug ??= await collectRapidNavigationDebug(session).catch(() => null);
            if (trace.length === 0) {
                trace = await collectTrace(session).catch(() => []);
            }
            const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
            const targetPageState = visiblePages.find(page => page.page === 21) ?? null;
            writeTraceArtifact({
                pdfPath: pageJumpPdfPath,
                scenario: 'toolbar-rapid-next-to-21',
                failureMessage,
                navigationControls,
                rapidNavigationDebug,
                toolbarReachedTarget,
                visiblePages,
                targetPageState,
                targetCanvasMounted,
                blankVisiblePages,
                trace,
            }, RAPID_NEXT_TRACE_OUTPUT_PATH);
        }

        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === 21) ?? null;

        expect(targetCanvasMounted).toBe(true);
        expect(targetPageState).not.toBeNull();
        expect(targetPageState?.topmost).toBe(true);
        expect(blankVisiblePages).toEqual([]);
    }, 80_000);

    it('keeps the first committed page crisp without a quality-promotion replacement after revisit', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForScannedFixturePageIdentity(session.page, 1, 15_000);
        const marker = `first-commit-${String(Date.now())}`;
        const initial = await collectCommittedCanvasQuality(session, 1, marker);
        expect(initial).not.toBeNull();
        expect(initial?.rendered).toBe(true);
        expect(initial?.skeletonVisible).toBe(false);
        expect(initial?.backingScaleX).toBeGreaterThanOrEqual(1);
        expect(initial?.backingScaleY).toBeGreaterThanOrEqual(1);
        expect(initial?.luminanceVariance).toBeGreaterThan(0);

        await clickPageNavigationButton(session, 'Next Page');
        await waitForToolbarCurrentPage(session, 2);
        expect(await waitForVisiblePageCanvas(session, 2, 15_000)).toBe(true);
        await clickPageNavigationButton(session, 'Previous Page');
        await waitForToolbarCurrentPage(session, 1);
        expect(await waitForVisiblePageCanvas(session, 1, 15_000)).toBe(true);

        const revisited = await collectCommittedCanvasQuality(session, 1);
        expect(revisited).not.toBeNull();
        expect(revisited).toMatchObject({
            backingHeight: initial?.backingHeight,
            backingWidth: initial?.backingWidth,
            marker,
            rendered: true,
            skeletonVisible: false,
        });
        expect(revisited?.cssHeight).toBeCloseTo(initial?.cssHeight ?? 0, 1);
        expect(revisited?.cssWidth).toBeCloseTo(initial?.cssWidth ?? 0, 1);
        expect(revisited?.backingScaleX).toBeCloseTo(initial?.backingScaleX ?? 0, 3);
        expect(revisited?.backingScaleY).toBeCloseTo(initial?.backingScaleY ?? 0, 3);
        expect(revisited?.luminanceVariance).toBeCloseTo(initial?.luminanceVariance ?? 0, 3);
    }, 60_000);

    it('keeps exact page-track geometry and renders every visible page beyond the initial wheel buffer', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForVisibleMountedPdfCanvases(session.page, 15_000);
        await waitForScannedFixturePageIdentity(session.page, 1, 15_000);

        const samples = [await collectPdfVirtualizationSnapshot(session.page)];
        const initialPageGaps = await collectConsecutivePageGaps(session);
        let maxMountedPage = Math.max(...samples[0]!.mountedPages.map(page => page.pageNumber));
        const wheelScrollViolations: string[] = [];
        for (let step = 0; step < 60 && maxMountedPage < 30; step += 1) {
            const previous = samples.at(-1)!;
            const deltaY = Math.max(300, Math.round(previous.viewportHeight * 0.8));
            const settlement = await wheelPdfViewportAndWaitForSettlement(session.page, deltaY);
            const sample = await collectPdfVirtualizationSnapshot(session.page);
            const expectedScrollTop = Math.min(
                settlement.initialScrollTop + deltaY,
                settlement.maxScrollTop,
            );
            if (Math.abs(settlement.finalScrollTop - expectedScrollTop) > 1) {
                wheelScrollViolations.push(
                    `step ${step}: scrollTop ${settlement.finalScrollTop}px, expected ${expectedScrollTop}px after ${deltaY}px wheel`,
                );
            }
            samples.push(sample);
            maxMountedPage = Math.max(maxMountedPage, ...sample.mountedPages.map(page => page.pageNumber));
        }

        await waitForVisibleMountedPdfCanvases(session.page, 15_000);
        await waitForAnimationFrames(session.page, 2);
        samples.push(await collectPdfVirtualizationSnapshot(session.page));

        const finalSample = samples.at(-1)!;
        const finalPageGaps = await collectConsecutivePageGaps(session);
        const geometryViolations = findPdfVirtualizationContractViolations(
            samples,
        );
        const uncommittedVisiblePages = finalSample.visiblePages.filter(page => (
            !page.canvasConnected
            || page.canvasWidth <= 0
            || page.canvasHeight <= 0
            || !page.rendered
            || page.skeletonVisible
        ));
        writeTraceArtifact({
            geometryViolations,
            maxMountedPage,
            initialPageGaps,
            finalPageGaps,
            samples,
            scenario: 'continuous-wheel-beyond-initial-buffer',
            uncommittedVisiblePages,
            wheelScrollViolations,
        }, CONTINUOUS_SCROLL_TRACE_OUTPUT_PATH);

        expect(maxMountedPage).toBeGreaterThanOrEqual(30);
        expect(finalSample.totalPages).toBe(GENERATED_PAGE_JUMP_PAGE_COUNT);
        await waitForScannedFixturePageIdentity(
            session.page,
            finalSample.visiblePages[0]?.pageNumber ?? maxMountedPage,
            15_000,
        );
        expect(uncommittedVisiblePages).toEqual([]);
        expect(geometryViolations).toEqual([]);
        expect(wheelScrollViolations).toEqual([]);
        expect(initialPageGaps.length).toBeGreaterThan(0);
        expect(finalPageGaps.length).toBeGreaterThan(0);
        for (const pageGap of [
            ...initialPageGaps,
            ...finalPageGaps,
        ]) {
            expect(pageGap.gap, JSON.stringify(pageGap)).toBeCloseTo(20, 0);
        }
    }, 90_000);

    it('never exposes a frame without a page skeleton or committed canvas during rapid Next then Fit Width', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await jumpToPageAndWaitForCanvas(session, 1);
        await waitForVisibleMountedPdfCanvases(session.page, 15_000);
        const actualSize = await callWorkspaceCommand(session.page, 'handleActualSize');
        expect(actualSize.called).toBe(true);
        await session.page.waitForFunction(() => (
            (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
        ), {timeout: 15_000});
        await waitForVisiblePageCanvas(session, 1, 15_000);
        expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('custom');
        await installCommittedSurfaceSampler(session.page);

        let surfaceTrace: Awaited<ReturnType<typeof stopCommittedSurfaceSampler>> = {frames: []};
        try {
            await clickPageNavigationButton(session, 'Next Page');
            const fitWidth = await callWorkspaceCommand(session.page, 'handleFitWidth');
            expect(fitWidth.called).toBe(true);
            await waitForToolbarCurrentPage(session, 2);
            await session.page.waitForFunction(() => (
                (window as IRapidNavigationProbeWindow).__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
            ), {timeout: 15_000});
            expect(await waitForVisiblePageCanvas(session, 2, 15_000)).toBe(true);
            await waitForAnimationFrames(session.page, 10);
        } finally {
            surfaceTrace = await stopCommittedSurfaceSampler(session.page);
        }

        const missingVisualFrames = findMissingVisualFrames(surfaceTrace.frames);
        writeTraceArtifact({
            missingVisualFrames,
            scenario: 'rapid-next-then-fit-width',
            surfaceTrace,
        }, NEXT_FIT_WIDTH_TRACE_OUTPUT_PATH);

        // A cached target can complete within two browser-presentable RAFs;
        // both frames are still inspected for an owned shell or committed
        // canvas, so fast completion must not be treated as missing evidence.
        expect(surfaceTrace.frames.length).toBeGreaterThanOrEqual(2);
        expect(missingVisualFrames).toEqual([]);
        expect((await getWorkspaceToolbarSnapshot(session.page))?.zoomMode).toBe('fit-width');
    }, 60_000);

    it('keeps page overlays mounted after jumping to page 100', async () => {
        const session = sessionFixture.getSession();
        if (!session || !pageJumpReady || !pageJumpPdfPath) {
            return;
        }

        await delay(5_000);
        await jumpToPageAndWaitForCanvas(session, TARGET_PAGE);
        await delay(6_000);

        const visiblePages = await collectVisiblePageState(session);
        const navigationControls = await collectNavigationControlState(session);
        const virtualScrollGeometry = await collectVirtualScrollGeometry(session, TARGET_PAGE);
        const trace = await collectTrace(session);
        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        const targetPageState = visiblePages.find(page => page.page === TARGET_PAGE) ?? null;
        writeTraceArtifact({
            pdfPath: pageJumpPdfPath,
            targetPage: TARGET_PAGE,
            navigationControls,
            virtualScrollGeometry,
            visiblePages,
            targetPageState,
            blankVisiblePages,
            trace,
        });

        expect(targetPageState).not.toBeNull();
        expect(targetPageState?.topmost).toBe(true);
        expect(blankVisiblePages).toEqual([]);
    }, 60_000);
});
