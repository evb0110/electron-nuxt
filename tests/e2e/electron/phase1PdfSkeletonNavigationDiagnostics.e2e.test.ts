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
} from '@tests/e2e/electron/helpers/sessionHarness';
import { openPdfInApp } from '@tests/e2e/electron/helpers/viewerCore';

const TARGET_PDF_PATH = '.devkit/manual-pdf-fixtures/Гиргас - Словарь к арабской хрестоматии и Корану_oo.pdf';
const DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-page-navigation-skeleton-diagnostics.json',
);
const DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH = resolve(
    process.cwd(),
    '.devkit',
    'girgas-page-500-input-skeleton-diagnostics.json',
);

interface IWorkspaceComponentElement extends HTMLElement {__vueParentComponent?: {
    exposed?: IWorkspaceExpose;
    parent?: IWorkspaceComponentElement['__vueParentComponent'];
};}

interface IWorkspaceToolbarSnapshot {
    effectiveZoom: number;
    continuousScroll: boolean;
}

interface IWorkspaceExpose {
    getToolbarSnapshot?: () => IWorkspaceToolbarSnapshot;
    handleActualSize?: () => void;
    handleZoomIn?: () => void;
    handleViewModeSingle?: () => void;
    handleToggleContinuousScroll?: () => void;
}

type TPdfNavLogEntry = {
    message: string;
    args: unknown[];
    loggedAtMs: number;
};

type TPdfRenderTraceEntry = {
    event: string;
    payload: Record<string, unknown>;
};

type TNavigationSample = {
    sampledAtMs: number;
    currentPageText: string | null;
    skeletonPages: number[];
    renderedPages: number[];
    canvasPages: number[];
};

function writeDiagnosticArtifact(payload: unknown) {
    mkdirSync(dirname(DIAGNOSTIC_OUTPUT_PATH), { recursive: true });
    writeFileSync(DIAGNOSTIC_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeDirectJumpDiagnosticArtifact(payload: unknown) {
    mkdirSync(dirname(DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH), { recursive: true });
    writeFileSync(DIRECT_JUMP_DIAGNOSTIC_OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

async function enablePdfNavLog(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        localStorage.setItem('evb-viewer:pdf-nav-log', '1');
        localStorage.removeItem('evb-viewer:pdf-nav-log-console');
        localStorage.setItem('evb-viewer:pdf-render-trace', '1');
        localStorage.removeItem('evb-viewer:pdf-render-trace-console');
        const logWindow = window as Window & {
            __pdfNavLog?: boolean;
            __pdfNavLogConsole?: boolean;
            __clearPdfNavLog?: () => void;
            __pdfRenderTrace?: boolean;
            __pdfRenderTraceConsole?: boolean;
            __clearPdfRenderTrace?: () => void;
        };
        logWindow.__pdfNavLog = true;
        logWindow.__pdfNavLogConsole = false;
        logWindow.__clearPdfNavLog?.();
        logWindow.__pdfRenderTrace = true;
        logWindow.__pdfRenderTraceConsole = false;
        logWindow.__clearPdfRenderTrace?.();
    });
}

async function collectPdfNavLog(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const logWindow = window as Window & { __getPdfNavLog?: () => TPdfNavLogEntry[]; };
        return logWindow.__getPdfNavLog?.() ?? [];
    });
}

async function collectPdfRenderTrace(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const traceWindow = window as Window & { __getPdfRenderTrace?: () => TPdfRenderTraceEntry[]; };
        return traceWindow.__getPdfRenderTrace?.() ?? [];
    });
}

async function configureHighZoom(session: IElectronE2ESession, options: { continuousScroll: boolean } = { continuousScroll: false }) {
    await session.page.waitForFunction(() => Boolean(document.querySelector('#pdf-viewer')), { timeout: 20_000 });
    const configured = await session.page.evaluate((configuration: { continuousScroll: boolean }) => {
        function findWorkspaceExpose() {
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                let component = (element as IWorkspaceComponentElement).__vueParentComponent ?? null;
                while (component) {
                    const exposed = component.exposed;
                    if (
                        typeof exposed?.getToolbarSnapshot === 'function'
                        && typeof exposed.handleZoomIn === 'function'
                    ) {
                        return exposed;
                    }
                    component = component.parent ?? null;
                }
            }
            return null;
        }

        const workspace = findWorkspaceExpose();
        if (!workspace) {
            return false;
        }

        workspace.handleViewModeSingle?.();
        const isContinuousScroll = workspace.getToolbarSnapshot?.().continuousScroll === true;
        if (configuration.continuousScroll !== isContinuousScroll) {
            workspace.handleToggleContinuousScroll?.();
        }
        workspace.handleActualSize?.();
        for (let index = 0; index < 30; index += 1) {
            if ((workspace.getToolbarSnapshot?.().effectiveZoom ?? 0) >= 3.4) {
                break;
            }
            workspace.handleZoomIn?.();
        }
        return true;
    }, options);

    if (!configured) {
        throw new Error('Unable to configure workspace zoom/page state');
    }

    await delay(500);
}

async function waitForToolbarPage(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((targetPage: number) => {
        return Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
            .some(element => element.textContent?.trim() === String(targetPage));
    }, { timeout: 15_000 }, pageNumber);
}

async function clickNextPage(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button'))
            .some(button => {
                const label = button.getAttribute('aria-label') ?? '';
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return label === 'Next Page'
                    && !button.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 30_000 });
    const clicked = await session.page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls button'));
        const isVisibleEnabled = (candidate: HTMLButtonElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return !candidate.disabled
                && rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        const button = candidates.find((candidate) => {
            const label = candidate.getAttribute('aria-label') ?? '';
            const hasNextIcon = Boolean(candidate.querySelector('.i-ph-caret-right, .iconify.i-ph-caret-right'));
            return (label.startsWith('Next Page') || hasNextIcon) && isVisibleEnabled(candidate);
        })
            ?? candidates.filter(isVisibleEnabled)[0]
            ?? null;
        button?.click();
        return Boolean(button);
    });
    if (!clicked) {
        const state = await session.page.evaluate(() => ({
            pageControlsCount: document.querySelectorAll('.page-controls').length,
            pageControlsHtml: Array.from(document.querySelectorAll<HTMLElement>('.page-controls'))
                .map(element => element.outerHTML.slice(0, 1000)),
            buttonLabels: Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
                .map(button => ({
                    className: button.className,
                    label: button.getAttribute('aria-label'),
                    disabled: button.disabled,
                    text: button.textContent?.trim() ?? '',
                }))
                .slice(0, 50),
        }));
        throw new Error(`Unable to click the Next Page toolbar button: ${JSON.stringify(state)}`);
    }
}

async function waitForPageCanvas(session: IElectronE2ESession, pageNumber: number) {
    await session.page.waitForFunction((targetPage: number) => {
        const container = document.querySelector<HTMLElement>(`.page_container[data-page="${targetPage}"]`);
        return Boolean(
            container?.classList.contains('page_container--rendered')
            && container.querySelector('.page_canvas canvas'),
        );
    }, { timeout: 20_000 }, pageNumber);
}

async function enterPageInToolbar(session: IElectronE2ESession, pageInput: string) {
    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls-display'))
            .some(button => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return !button.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 30_000 });

    const clicked = await session.page.evaluate(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.page-controls-display'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return !candidate.disabled
                    && rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        button?.click();
        return Boolean(button);
    });
    if (!clicked) {
        throw new Error('Unable to click the page display');
    }

    await session.page.waitForFunction(() => {
        return Array.from(document.querySelectorAll<HTMLInputElement>('.page-controls-inline-input'))
            .some(input => {
                const rect = input.getBoundingClientRect();
                const style = window.getComputedStyle(input);
                return rect.width > 8
                    && rect.height > 8
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
    }, { timeout: 10_000 });

    await session.page.keyboard.type(pageInput);
    await session.page.keyboard.press('Enter');
}

async function navigateToPageWithNextButton(session: IElectronE2ESession, pageNumber: number) {
    for (let target = 2; target <= pageNumber; target += 1) {
        await clickNextPage(session);
        await waitForToolbarPage(session, target);
    }
    await waitForPageCanvas(session, pageNumber);
}

async function navigateForwardWithNextButton(session: IElectronE2ESession, steps: number) {
    for (let step = 0; step < steps; step += 1) {
        const currentPage = await session.page.evaluate(() => {
            const text = document.querySelector<HTMLElement>('.page-controls-current-primary')?.textContent?.trim() ?? '';
            return Number.parseInt(text, 10);
        });
        await clickNextPage(session);
        if (Number.isFinite(currentPage)) {
            await waitForToolbarPage(session, currentPage + 1);
        }
    }
}

async function sampleNavigation(session: IElectronE2ESession) {
    const samples: TNavigationSample[] = [];
    const startedAt = Date.now();
    for (let index = 0; index < 180; index += 1) {
        samples.push(await session.page.evaluate((startedAtMs: number): TNavigationSample => {
            const pageContainers = Array.from(document.querySelectorAll<HTMLElement>('.page_container'));
            const visiblePageContainers = pageContainers.filter((container) => {
                const rect = container.getBoundingClientRect();
                return rect.bottom > 0 && rect.top < window.innerHeight;
            });
            const pageNumber = (container: HTMLElement) => Number(container.dataset.page) || 0;
            const skeletonPages = visiblePageContainers
                .filter(container => Boolean(container.querySelector('.pdf-page-skeleton')))
                .map(pageNumber);
            const renderedPages = visiblePageContainers
                .filter(container => container.classList.contains('page_container--rendered'))
                .map(pageNumber);
            const canvasPages = visiblePageContainers
                .filter(container => Boolean(container.querySelector('.page_canvas canvas')))
                .map(pageNumber);
            return {
                sampledAtMs: Date.now() - startedAtMs,
                currentPageText: document.querySelector<HTMLElement>('.page-controls-current-primary')?.textContent?.trim() ?? null,
                skeletonPages,
                renderedPages,
                canvasPages,
            };
        }, startedAt));
        await delay(10);
    }
    return samples;
}

describe('Electron E2E - PDF Navigation Skeleton Diagnostics', () => {
    let session: IElectronE2ESession | null = null;

    beforeAll(async () => {
        if (!existsSync(TARGET_PDF_PATH)) {
            return;
        }
        session = await startElectronE2ESession(`e2e-girgas-skeleton-${Date.now()}`);
        await enablePdfNavLog(session);
        await openPdfInApp(session.page, TARGET_PDF_PATH, 60_000);
        await enablePdfNavLog(session);
    }, 120_000);

    afterAll(async () => {
        await session?.stop();
    });

    it.runIf(existsSync(TARGET_PDF_PATH))('does not show a page skeleton during high-zoom next-page navigation', async () => {
        if (!session) {
            throw new Error('Diagnostic session was not initialized');
        }

        let samples: TNavigationSample[] = [];
        let navLog: TPdfNavLogEntry[] = [];
        let renderTrace: TPdfRenderTraceEntry[] = [];
        try {
            await navigateToPageWithNextButton(session, 55);
            await configureHighZoom(session);
            await waitForPageCanvas(session, 55);
            await delay(500);
            await enablePdfNavLog(session);
            await clickNextPage(session);
            samples = await sampleNavigation(session);
            navLog = await collectPdfNavLog(session);
            renderTrace = await collectPdfRenderTrace(session);
        } finally {
            if (samples.length === 0) {
                samples = await sampleNavigation(session).catch(() => []);
            }
            if (navLog.length === 0) {
                navLog = await collectPdfNavLog(session).catch(() => []);
            }
            if (renderTrace.length === 0) {
                renderTrace = await collectPdfRenderTrace(session).catch(() => []);
            }
            writeDiagnosticArtifact({
                pdfPath: TARGET_PDF_PATH,
                scenario: 'page-55-next-to-56-zoom-344',
                samples,
                navLog,
                renderTrace,
                skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
                skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
            });
        }

        const skeletonSamples = samples.filter(sample => sample.skeletonPages.length > 0);
        const skeletonLogEntries = navLog.filter(entry => entry.message.includes('page skeleton visible'));

        expect(skeletonSamples).toEqual([]);
        expect(skeletonLogEntries).toEqual([]);
    }, 90_000);

    it.runIf(existsSync(TARGET_PDF_PATH))('renders after entering page 500 in the toolbar', async () => {
        if (!session) {
            throw new Error('Diagnostic session was not initialized');
        }

        let samples: TNavigationSample[] = [];
        let navLog: TPdfNavLogEntry[] = [];
        let renderTrace: TPdfRenderTraceEntry[] = [];
        try {
            await navigateForwardWithNextButton(session, 3);
            await configureHighZoom(session, { continuousScroll: true });
            await enablePdfNavLog(session);
            await enterPageInToolbar(session, '500');
            samples = await sampleNavigation(session);
            navLog = await collectPdfNavLog(session);
            renderTrace = await collectPdfRenderTrace(session);
        } finally {
            if (samples.length === 0) {
                samples = await sampleNavigation(session).catch(() => []);
            }
            if (navLog.length === 0) {
                navLog = await collectPdfNavLog(session).catch(() => []);
            }
            if (renderTrace.length === 0) {
                renderTrace = await collectPdfRenderTrace(session).catch(() => []);
            }
            writeDirectJumpDiagnosticArtifact({
                pdfPath: TARGET_PDF_PATH,
                scenario: 'toolbar-enter-page-500-after-navigation-zoom-344',
                samples,
                navLog,
                renderTrace,
                skeletonSamples: samples.filter(sample => sample.skeletonPages.length > 0),
                canvasSamples: samples.filter(sample => sample.canvasPages.length > 0),
                lastSample: samples.at(-1) ?? null,
                skeletonLogEntries: navLog.filter(entry => entry.message.includes('page skeleton visible')),
            });
        }

        const lastSample = samples.at(-1);
        expect(lastSample?.skeletonPages).toEqual([]);
        expect(lastSample?.canvasPages.length ?? 0).toBeGreaterThan(0);
    }, 90_000);
});
