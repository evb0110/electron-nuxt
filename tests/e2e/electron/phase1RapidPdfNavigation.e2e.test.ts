import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import { openPdfInApp } from './helpers/viewerCore';

const RAPID_NAV_PDF_PATH = '.devkit/manual-pdf-fixtures/History of Ancient Rome_2005.pdf';
const TRACE_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'pdf-rapid-navigation-trace.json',
);

type TPdfRenderTraceEntry = {
    event: string;
    payload: Record<string, unknown>;
};

interface IVisiblePageState {
    page: number | null;
    renderedClass: boolean;
    hasCanvas: boolean;
    canvasCount: number;
    textSpanCount: number;
    skeletonDisplay: string | null;
    rectTop: number;
    rectHeight: number;
}

interface IPageButtonState {
    label: string;
    disabled: boolean;
    visible: boolean;
}

function writeTraceArtifact(payload: unknown) {
    mkdirSync(dirname(TRACE_OUTPUT_PATH), { recursive: true });
    writeFileSync(TRACE_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

async function enableBufferedPdfTrace(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        localStorage.setItem('evb-viewer:pdf-render-trace', '1');
        localStorage.removeItem('evb-viewer:pdf-render-trace-console');
        const traceWindow = window as Window & {
            __pdfRenderTrace?: boolean;
            __pdfRenderTraceConsole?: boolean;
            __clearPdfRenderTrace?: () => void;
        };
        traceWindow.__pdfRenderTrace = true;
        traceWindow.__pdfRenderTraceConsole = false;
        traceWindow.__clearPdfRenderTrace?.();
    });
}

async function getVisiblePageButtonCenter(session: IElectronE2ESession, labelPattern: RegExp) {
    await session.page.waitForFunction((labelSource: string) => {
        const labelRegex = new RegExp(labelSource, 'i');
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .some(candidate => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    labelRegex.test(candidate.getAttribute('aria-label') ?? '')
                    && !candidate.disabled
                    && rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                );
            });
    }, { timeout: 15_000 }, labelPattern.source);

    return session.page.evaluate((labelSource: string) => {
        const labelRegex = new RegExp(labelSource, 'i');
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
            .find(candidate => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    labelRegex.test(candidate.getAttribute('aria-label') ?? '')
                    && !candidate.disabled
                    && rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                );
            });
        if (!button) {
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button[aria-label]'))
                .map(candidate => ({
                    label: candidate.getAttribute('aria-label') ?? '',
                    disabled: candidate.disabled,
                    rect: candidate.getBoundingClientRect().toJSON(),
                }));
            throw new Error(`Visible enabled page button matching ${labelSource} was not found: ${JSON.stringify(buttons)}`);
        }
        const rect = button.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, labelPattern.source);
}

async function clickNextRapidly(session: IElectronE2ESession, count: number) {
    for (let index = 0; index < count; index += 1) {
        const center = await getVisiblePageButtonCenter(session, /next/);
        await session.page.mouse.click(center.x, center.y);
    }
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
        const traceWindow = window as Window & { __getPdfRenderTrace?: () => TPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

describe('Electron E2E - Phase 1 (Rapid PDF Navigation)', () => {
    let session: IElectronE2ESession | null = null;

    beforeAll(async () => {
        if (!existsSync(RAPID_NAV_PDF_PATH)) {
            return;
        }
        session = await startElectronE2ESession(`e2e-rapid-pdf-nav-${Date.now()}`);
        await enableBufferedPdfTrace(session);
        await openPdfInApp(session.page, RAPID_NAV_PDF_PATH, 45_000);
    }, 90_000);

    afterAll(async () => {
        await session?.stop();
    });

    it.runIf(existsSync(RAPID_NAV_PDF_PATH))('keeps the destination page rendered after very fast next-page clicks', async () => {
        if (!session) {
            throw new Error('Rapid navigation session was not initialized');
        }

        await clickNextRapidly(session, 15);
        await delay(12_000);

        const visiblePages = await collectVisiblePageState(session);
        const navigationControls = await collectNavigationControlState(session);
        const trace = await collectTrace(session);
        const blankVisiblePages = visiblePages.filter(page => !page.hasCanvas || !page.renderedClass);
        writeTraceArtifact({
            pdfPath: RAPID_NAV_PDF_PATH,
            navigationControls,
            visiblePages,
            blankVisiblePages,
            trace,
        });

        expect(blankVisiblePages).toEqual([]);
    }, 60_000);
});
