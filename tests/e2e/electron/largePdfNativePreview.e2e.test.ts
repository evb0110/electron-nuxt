import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    resolveNativeLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickVisibleToolbarButton,
    installNativePdfOpeningSampler,
    openPdfInApp,
    stopNativePdfOpeningSampler,
    triggerOpenPathInApp,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const GENERATED_LARGE_PDF_PAGE_COUNT = 431;
const EXACT_DICTIONARY_PAGE_COUNT = 882;
const NAVIGATION_ACCEPTANCE_PAGE = 64;
const generatedLargePdf = resolveNativeLargePdfFixtureAvailability(GENERATED_LARGE_PDF_PAGE_COUNT);
const largePdfDescribe = selectFixtureDescribe(describe, generatedLargePdf);
const exactLargePdfPath = process.env.EVB_E2E_EXACT_NATIVE_PDF_PATH?.trim() ?? '';

interface IPdfNavigationFrame {
    committedPage: number | null;
    mountedPages: number[];
    requestedPage: number | null;
    renderedCanvasRects: Array<{
        bottom: number;
        page: number;
        top: number;
    }>;
    viewportScrollHeight: number | null;
    viewportScrollTop: number | null;
    visibleCanvasPages: number[];
    visibleSkeletonCount: number;
    visibleSkeletonPages: number[];
}

async function installPdfNavigationSampler(page: Page) {
    await page.evaluate(() => {
        interface INavigationSamplerWindow extends Window {
            __pdfNavigationFrame?: number;
            __pdfNavigationFrames?: IPdfNavigationFrame[];
            __pdfNavigationPreviousRenderTrace?: boolean | undefined;
            __pdfRenderTrace?: boolean;
            __clearPdfRenderTrace?: () => void;
        }
        const samplerWindow = window as INavigationSamplerWindow;
        if (samplerWindow.__pdfNavigationFrame !== undefined) {
            cancelAnimationFrame(samplerWindow.__pdfNavigationFrame);
        }
        const frames: IPdfNavigationFrame[] = [];
        samplerWindow.__pdfNavigationFrames = frames;
        samplerWindow.__pdfNavigationPreviousRenderTrace = samplerWindow.__pdfRenderTrace;
        samplerWindow.__pdfRenderTrace = true;
        samplerWindow.__clearPdfRenderTrace?.();
        const capture = () => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            const viewport = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            const intersectsViewport = (element: HTMLElement) => {
                const rect = element.getBoundingClientRect();
                return viewportRect !== null
                    && rect.right > viewportRect.left
                    && rect.left < viewportRect.right
                    && rect.bottom > viewportRect.top
                    && rect.top < viewportRect.bottom;
            };
            const isVisible = (element: HTMLElement) => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0;
            };
            const parsePage = (value: string | undefined) => {
                const parsed = Number(value);
                return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
            };
            const visibleSkeletonPages = Array.from(
                host?.querySelectorAll<HTMLElement>('.document-page-skeleton') ?? [],
            ).filter(skeleton => isVisible(skeleton) && intersectsViewport(skeleton)).map(skeleton => (
                Number(skeleton.closest<HTMLElement>('.page_container')?.dataset.page ?? 0)
            )).filter(pageNumber => pageNumber > 0);
            const mountedPages = Array.from(
                host?.querySelectorAll<HTMLElement>('.page_container') ?? [],
            );
            const renderedCanvases = mountedPages.flatMap((pageElement) => {
                const canvas = pageElement.querySelector<HTMLCanvasElement>(
                    '.page_canvas__render-layer canvas, .page_canvas canvas',
                );
                if (!canvas || canvas.width <= 0 || canvas.height <= 0 || !isVisible(canvas)) {
                    return [];
                }
                const rect = canvas.getBoundingClientRect();
                return [{
                    bottom: Math.round(rect.bottom),
                    canvas,
                    page: Number(pageElement.dataset.page ?? 0),
                    top: Math.round(rect.top),
                }];
            });
            frames.push({
                committedPage: parsePage(chassis?.dataset.viewportCommittedPage),
                mountedPages: mountedPages.map(pageElement => (
                    Number(pageElement.dataset.page ?? 0)
                )).filter(pageNumber => pageNumber > 0),
                requestedPage: parsePage(chassis?.dataset.viewportRequestedPage),
                renderedCanvasRects: renderedCanvases.map(({
                    canvas: _canvas,
                    ...rect
                }) => rect),
                viewportScrollHeight: viewport?.scrollHeight ?? null,
                viewportScrollTop: viewport?.scrollTop ?? null,
                visibleCanvasPages: renderedCanvases.filter(({canvas}) => (
                    intersectsViewport(canvas)
                )).map(({page: pageNumber}) => pageNumber).filter(pageNumber => pageNumber > 0),
                visibleSkeletonCount: visibleSkeletonPages.length,
                visibleSkeletonPages,
            });
            samplerWindow.__pdfNavigationFrame = requestAnimationFrame(capture);
        };
        capture();
    });
}

async function stopPdfNavigationSampler(page: Page) {
    return page.evaluate(() => {
        interface INavigationSamplerWindow extends Window {
            __pdfNavigationFrame?: number;
            __pdfNavigationFrames?: IPdfNavigationFrame[];
            __pdfNavigationPreviousRenderTrace?: boolean | undefined;
            __pdfRenderTrace?: boolean;
        }
        const samplerWindow = window as INavigationSamplerWindow;
        if (samplerWindow.__pdfNavigationFrame !== undefined) {
            cancelAnimationFrame(samplerWindow.__pdfNavigationFrame);
        }
        const frames = samplerWindow.__pdfNavigationFrames ?? [];
        if (samplerWindow.__pdfNavigationPreviousRenderTrace === undefined) {
            delete samplerWindow.__pdfRenderTrace;
        } else {
            samplerWindow.__pdfRenderTrace = samplerWindow.__pdfNavigationPreviousRenderTrace;
        }
        delete samplerWindow.__pdfNavigationFrame;
        delete samplerWindow.__pdfNavigationFrames;
        delete samplerWindow.__pdfNavigationPreviousRenderTrace;
        return frames;
    });
}

async function openWithHandoffTrace(
    page: Page,
    pdfPath: string,
    duringNativePreview?: () => Promise<void>,
) {
    const priorPdfPath = await createMultiPageTextFixturePdf(
        `large-pdf-handoff-prior-${Date.now()}.pdf`,
        2,
    );
    await openPdfInApp(page, priorPdfPath, LARGE_PDF_TIMEOUT_MS);
    await installNativePdfOpeningSampler(page);
    const startedAt = await page.evaluate(() => performance.now());
    let frames: Awaited<ReturnType<typeof stopNativePdfOpeningSampler>> = [];
    try {
        const triggerOpen = triggerOpenPathInApp(page, pdfPath, LARGE_PDF_TIMEOUT_MS);
        const assertNativePreview = duringNativePreview?.() ?? Promise.resolve();
        const [
            openResult,
            previewResult,
        ] = await Promise.allSettled([
            triggerOpen,
            assertNativePreview,
        ]);
        if (previewResult.status === 'rejected') {
            throw previewResult.reason;
        }
        if (openResult.status === 'rejected') {
            throw openResult.reason;
        }
        await waitForActiveDocumentSource(page, pdfPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await delay(100);
    } finally {
        frames = await stopNativePdfOpeningSampler(page);
    }
    return {
        frames,
        startedAt,
    };
}

async function assertNativeOpeningPreviewIsViewable(page: Page, expectedTotalPages: number) {
    const previewBeforeHandle = await waitForFunctionInPage(page, () => {
        const preview = document.querySelector<HTMLImageElement>(
            '.editor-pane.is-active [data-testid="document-opening-native-preview"]',
        );
        const shell = preview?.closest<HTMLElement>('[data-document-page-number]') ?? null;
        return preview?.complete === true && (preview.naturalWidth ?? 0) > 0 && shell
            ? {
                objectUrl: preview.currentSrc || preview.src,
                pageNumber: Number(shell.dataset.documentPageNumber ?? 0),
            }
            : null;
    }, {timeout: 10_000});
    const previewBefore = await previewBeforeHandle.jsonValue() as {
        objectUrl: string;
        pageNumber: number;
    };
    expect(previewBefore.pageNumber).toBe(1);

    const openingToolbar = await getWorkspaceToolbarSnapshot(page);
    expect(openingToolbar).toMatchObject({
        hasPdf: true,
        isOpeningDocument: true,
        openingPreviewReady: true,
        currentPage: 1,
        totalPages: expectedTotalPages,
    });

    const controlState = await page.evaluate(() => {
        const toolbarHost = document.getElementById('editor-global-toolbar-host');
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };
        const findButton = (label: string) => Array.from(
            toolbarHost?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [],
        ).find(button => button.getAttribute('aria-label')?.startsWith(label) && isVisible(button));
        const pageDisplay = Array.from(
            toolbarHost?.querySelectorAll<HTMLButtonElement>('.page-controls-display') ?? [],
        ).find(isVisible);
        return {
            nextPageDisabled: findButton('Next Page')?.disabled ?? null,
            pageDisplayDisabled: pageDisplay?.disabled ?? null,
            pageDisplayText: pageDisplay?.textContent?.replace(/\s+/gu, '') ?? '',
            saveDisabled: findButton('Save')?.disabled ?? null,
            sidebarDisabled: findButton('Toggle Sidebar')?.disabled ?? null,
            zoomInDisabled: findButton('Zoom In')?.disabled ?? null,
        };
    });
    expect(controlState, JSON.stringify(controlState)).toMatchObject({
        nextPageDisabled: false,
        pageDisplayDisabled: false,
        saveDisabled: true,
        sidebarDisabled: false,
        zoomInDisabled: false,
    });
    expect(controlState.pageDisplayText).toContain('/' + String(expectedTotalPages));

    await clickVisibleToolbarButton(page, 'Next Page');
    const previewAfterHandle = await waitForFunctionInPage(page, (previousObjectUrl: string) => {
        const preview = document.querySelector<HTMLImageElement>(
            '.editor-pane.is-active [data-testid="document-opening-native-preview"]',
        );
        const shell = preview?.closest<HTMLElement>('[data-document-page-number]') ?? null;
        const objectUrl = preview?.currentSrc || preview?.src || '';
        return preview?.complete === true
            && (preview.naturalWidth ?? 0) > 0
            && Number(shell?.dataset.documentPageNumber ?? 0) === 2
            && objectUrl !== previousObjectUrl
            ? {
                objectUrl,
                pageNumber: 2,
            }
            : null;
    }, {timeout: 10_000}, previewBefore.objectUrl);
    const previewAfter = await previewAfterHandle.jsonValue() as {
        objectUrl: string;
        pageNumber: number;
    };
    expect(previewAfter.pageNumber).toBe(2);
    expect(await getWorkspaceToolbarSnapshot(page)).toMatchObject({
        currentPage: 2,
        totalPages: expectedTotalPages,
    });
    await waitForFunctionInPage(page, (expectedPageDisplay: string) => {
        const toolbarHost = document.getElementById('editor-global-toolbar-host');
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        };
        return Array.from(toolbarHost?.querySelectorAll<HTMLElement>('.page-controls-display') ?? [])
            .some(control => (
                isVisible(control)
                && control.textContent?.replace(/\s+/gu, '').includes(expectedPageDisplay)
            ));
    }, {timeout: 10_000}, `2/${String(expectedTotalPages)}`);

    await clickVisibleToolbarButton(page, 'Toggle Sidebar');
    await waitForWorkspaceToolbarSnapshot(page, {showSidebar: true}, {timeoutMs: 10_000});
    const sidebarStateHandle = await waitForFunctionInPage(page, () => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const wrapper = host?.querySelector<HTMLElement>('.sidebar-wrapper') ?? null;
        const sidebar = wrapper?.querySelector<HTMLElement>('[data-testid="document-sidebar"]') ?? null;
        const targetRow = sidebar?.querySelector<HTMLElement>('[data-thumbnail-page="3"]') ?? null;
        const rect = sidebar?.getBoundingClientRect() ?? null;
        if (!wrapper) {
            return null;
        }
        return {
            className: sidebar?.className ?? '',
            hasTargetRow: Boolean(targetRow),
            rect: rect ? {
                height: rect.height,
                width: rect.width,
            } : null,
            wrapper: {
                ariaHidden: wrapper.getAttribute('aria-hidden'),
                className: wrapper.className,
                inert: wrapper.inert,
                style: wrapper.getAttribute('style'),
            },
        };
    }, {timeout: 10_000});
    const sidebarState = await sidebarStateHandle.jsonValue() as {
        className: string;
        hasTargetRow: boolean;
        rect: {
            height: number;
            width: number;
        } | null;
        wrapper: {
            ariaHidden: string | null;
            className: string;
            inert: boolean;
            style: string | null;
        };
    };
    expect(sidebarState.rect?.width ?? 0, JSON.stringify(sidebarState)).toBeGreaterThan(0);
    expect(sidebarState.hasTargetRow, JSON.stringify(sidebarState)).toBe(true);
    await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const row = host?.querySelector<HTMLElement>(
            '[data-testid="document-sidebar"] [data-thumbnail-page="3"]',
        ) ?? null;
        if (!row) {
            throw new Error('Native opening sidebar page 3 row is unavailable');
        }
        row.click();
    });
    await waitForWorkspaceToolbarSnapshot(page, {currentPage: 3}, {timeoutMs: 10_000});
    await waitForFunctionInPage(page, () => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return host?.querySelector<HTMLElement>(
            '[data-testid="document-sidebar"] [data-thumbnail-page="3"]',
        )?.getAttribute('aria-current') === 'page';
    }, {timeout: 10_000});
    await clickVisibleToolbarButton(page, 'Toggle Sidebar');
    await waitForWorkspaceToolbarSnapshot(page, {showSidebar: false}, {timeoutMs: 10_000});
}

function assertAtomicNativeToPdfjsHandoff(
    trace: Awaited<ReturnType<typeof openWithHandoffTrace>>,
) {
    const firstOpeningIndex = trace.frames.findIndex(frame => (
        frame.transitionSurfaceVisible
        && frame.claimed
        && frame.capturedAtMs >= trace.startedAt
    ));
    expect(firstOpeningIndex, JSON.stringify(trace.frames)).toBeGreaterThanOrEqual(0);
    const opening = trace.frames[firstOpeningIndex]!;
    expect(opening.capturedAtMs - trace.startedAt, JSON.stringify(trace.frames)).toBeLessThan(1_000);

    const generationFrames = trace.frames.slice(firstOpeningIndex).filter(frame => (
        frame.generation === opening.generation
        && frame.documentId === opening.documentId
    ));
    const firstPreviewIndex = generationFrames.findIndex(frame => frame.openingPreviewVisible);
    const firstPdfjsIndex = generationFrames.findIndex(frame => frame.pdfjsCanvasVisible);
    expect(firstPreviewIndex, JSON.stringify(generationFrames)).toBeGreaterThanOrEqual(0);
    expect(firstPdfjsIndex, JSON.stringify(generationFrames)).toBeGreaterThan(firstPreviewIndex);
    expect(
        generationFrames[firstPreviewIndex]!.capturedAtMs - opening.capturedAtMs,
        JSON.stringify(generationFrames),
    ).toBeLessThan(5_000);

    const visualHandoffFrames = generationFrames.slice(firstPreviewIndex, firstPdfjsIndex + 1);
    expect(visualHandoffFrames.length, JSON.stringify(generationFrames)).toBeGreaterThan(1);
    expect(visualHandoffFrames.every(frame => (
        frame.openingPreviewVisible || frame.pdfjsCanvasVisible
    )), JSON.stringify(visualHandoffFrames)).toBe(true);
    expect(generationFrames.every(frame => !frame.nativeViewerVisible), JSON.stringify(generationFrames)).toBe(true);
    expect(generationFrames.every(frame => !frame.nativeSkeletonVisible), JSON.stringify(generationFrames)).toBe(true);
    expect(generationFrames.some(frame => (
        frame.pdfjsCanvasVisible && !frame.openingPreviewVisible
    )), JSON.stringify(generationFrames)).toBe(true);
}

async function assertFinalPdfjsCapabilities(
    page: Page,
    expectedTotalPages?: number,
    selectableTextPage?: number,
) {
    const toolbar = await getWorkspaceToolbarSnapshot(page);
    expect(toolbar).toMatchObject({
        hasPdf: true,
        initialVisualReady: true,
        isOpeningDocument: false,
        viewerCapabilities: {
            crop: true,
            pdfMutationActions: true,
            save: true,
            saveAs: true,
            sidebar: true,
        },
    });
    if (expectedTotalPages !== undefined) {
        expect(toolbar?.totalPages).toBe(expectedTotalPages);
    }
    if (selectableTextPage !== undefined) {
        const navigation = await callWorkspaceCommand(page, 'handleGoToPage', [selectableTextPage]);
        expect(navigation.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            page,
            {currentPage: selectableTextPage},
            {timeoutMs: 30_000},
        );
    }

    await waitForFunctionInPage(page, () => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const standardViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        return [...(standardViewer?.querySelectorAll<HTMLElement>(
            '.text-layer span, .textLayer span',
        ) ?? [])].some(span => (span.textContent ?? '').trim().length > 0);
    }, {timeout: 30_000});

    const state = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const standardViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const nativeViewer = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const textSpan = standardViewer?.querySelector<HTMLElement>('.text-layer span, .textLayer span') ?? null;
        let selectedText = '';
        if (textSpan?.firstChild) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(textSpan);
            selection?.removeAllRanges();
            selection?.addRange(range);
            selectedText = selection?.toString() ?? '';
            selection?.removeAllRanges();
        }
        return {
            annotationEditorLayerCount: standardViewer?.querySelectorAll(
                '.annotation-editor-layer, .annotationEditorLayer',
            ).length ?? 0,
            layerStates: [...(standardViewer?.querySelectorAll<HTMLElement>('.page_container') ?? [])]
                .map(container => ({
                    layerReadiness: container.dataset.pageLayerReadiness ?? null,
                    page: container.dataset.page ?? null,
                    textReady: container.querySelector<HTMLElement>('.text-layer, .textLayer')
                        ?.dataset.pdfTextLayerReady ?? null,
                    textRendering: container.querySelector<HTMLElement>('.text-layer, .textLayer')
                        ?.dataset.pdfTextLayerRendering ?? null,
                    textSpans: container.querySelectorAll('.text-layer span, .textLayer span').length,
                })),
            nativeViewerCount: nativeViewer ? 1 : 0,
            openingLayerCount: host?.querySelectorAll('.document-viewer-chassis__opening-page').length ?? 0,
            selectedText,
            standardViewerCount: standardViewer ? 1 : 0,
            textSpanCount: standardViewer?.querySelectorAll('.text-layer span, .textLayer span').length ?? 0,
        };
    });
    expect(state.standardViewerCount, JSON.stringify(state)).toBe(1);
    expect(state.nativeViewerCount, JSON.stringify(state)).toBe(0);
    expect(state.openingLayerCount, JSON.stringify(state)).toBe(0);
    expect(state.annotationEditorLayerCount, JSON.stringify(state)).toBeGreaterThan(0);
    expect(state.textSpanCount, JSON.stringify(state)).toBeGreaterThan(0);
    expect(state.selectedText.trim().length, JSON.stringify(state)).toBeGreaterThan(0);

    const sidebarToggle = await callWorkspaceCommand(page, 'handleToggleSidebar');
    expect(sidebarToggle.called).toBe(true);
    await waitForWorkspaceToolbarSnapshot(page, {showSidebar: true}, {timeoutMs: 30_000});
    await waitForFunctionInPage(page, () => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const sidebar = host?.querySelector<HTMLElement>('[data-testid="document-sidebar"]');
        const current = sidebar?.querySelector<HTMLElement>('[aria-current="page"]') ?? null;
        const thumbnail = current?.querySelector<HTMLCanvasElement>('canvas')
            ?? current?.querySelector<HTMLImageElement>('img')
            ?? null;
        return Boolean(sidebar && current && thumbnail && (
            thumbnail instanceof HTMLCanvasElement
                ? thumbnail.width > 0 && thumbnail.height > 0
                : thumbnail.complete && thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0
        ));
    }, {timeout: 30_000});
    const closeSidebar = await callWorkspaceCommand(page, 'handleToggleSidebar');
    expect(closeSidebar.called).toBe(true);
    await waitForWorkspaceToolbarSnapshot(page, {showSidebar: false}, {timeoutMs: 30_000});
}

async function assertSkeletonFreePageJump(page: Page, targetPage: number) {
    const before = await getWorkspaceToolbarSnapshot(page);
    const previousPage = before?.currentPage ?? 1;
    await installPdfNavigationSampler(page);
    let frames: IPdfNavigationFrame[] = [];
    let navigationError: unknown = null;
    try {
        const navigation = await callWorkspaceCommand(page, 'handleGoToPage', [targetPage]);
        expect(navigation.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(page, {currentPage: targetPage}, {timeoutMs: 30_000});
        await waitForFunctionInPage(page, (pageNumber: number) => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const viewport = host?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            const pageElement = host?.querySelector<HTMLElement>(`.page_container[data-page="${String(pageNumber)}"]`) ?? null;
            const canvas = pageElement?.querySelector<HTMLCanvasElement>(
                '.page_canvas__render-layer canvas, .page_canvas canvas',
            ) ?? null;
            const pageRect = pageElement?.getBoundingClientRect() ?? null;
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            return canvas !== null
                && canvas.width > 0
                && canvas.height > 0
                && pageRect !== null
                && viewportRect !== null
                && pageRect.bottom > viewportRect.top
                && pageRect.top < viewportRect.bottom;
        }, {
            polling: 'raf',
            timeout: 30_000,
        }, targetPage);
        await delay(100);
    } catch (error) {
        navigationError = error;
    } finally {
        frames = await stopPdfNavigationSampler(page);
    }

    if (navigationError) {
        const diagnostics = await page.evaluate((pageNumber: number) => {
            const traceWindow = window as Window & {__getPdfRenderTrace?: () => Array<{
                event: string;
                payload: Record<string, unknown>
            }>;};
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const pageElement = host?.querySelector<HTMLElement>(`.page_container[data-page="${String(pageNumber)}"]`) ?? null;
            const canvas = pageElement?.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas') ?? null;
            return {
                chassis: host?.querySelector<HTMLElement>('.document-viewer-chassis')?.dataset ?? null,
                targetCanvas: canvas ? {
                    height: canvas.height,
                    width: canvas.width,
                } : null,
                targetPageClass: pageElement?.className ?? null,
                trace: (traceWindow.__getPdfRenderTrace?.() ?? []).filter(entry => (
                    entry.event.startsWith('navigation-')
                    || entry.event.includes('raster')
                )),
            };
        }, targetPage);
        throw new Error(`${String(navigationError)} Diagnostics: ${JSON.stringify({
            diagnostics,
            frames: frames.slice(-300),
            toolbar: await getWorkspaceToolbarSnapshot(page),
        })}`);
    }

    const firstTargetRequest = frames.findIndex(frame => frame.requestedPage === targetPage);
    const firstTargetCommit = frames.findIndex((frame, index) => (
        index >= firstTargetRequest && frame.committedPage === targetPage
    ));
    const navigationTrace = await page.evaluate(() => {
        const traceWindow = window as Window & {__getPdfRenderTrace?: () => Array<{
            event: string;
            payload: Record<string, unknown>;
        }>;};
        return (traceWindow.__getPdfRenderTrace?.() ?? []).filter(entry => (
            entry.event.startsWith('navigation-')
            || entry.event.startsWith('renderer-')
        ));
    });
    const evidence = JSON.stringify({
        frames,
        navigationTrace,
    });
    expect(firstTargetRequest, evidence).toBeGreaterThanOrEqual(0);
    expect(firstTargetCommit, evidence).toBeGreaterThan(firstTargetRequest);
    const transitionFrames = frames.slice(firstTargetRequest, firstTargetCommit + 1);
    expect(transitionFrames.every(frame => frame.visibleSkeletonCount === 0), evidence).toBe(true);
    expect(transitionFrames.every(frame => frame.visibleCanvasPages.length > 0), evidence).toBe(true);
    expect(transitionFrames.some(frame => (
        frame.committedPage === previousPage
        && frame.visibleCanvasPages.includes(previousPage)
    )), evidence).toBe(true);
    expect(transitionFrames.at(-1)?.visibleCanvasPages, evidence).toContain(targetPage);
}

largePdfDescribe('Electron E2E - Large PDF native opening preview handoff', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-opening-handoff-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });

    it('hands an oversized native first paint to the full PDF.js viewer', async () => {
        const session = sessionFixture.getSession();
        if (!session || !generatedLargePdf.path) {
            throw new Error(`Large-PDF fixture unavailable: ${generatedLargePdf.reason}`);
        }

        const trace = await openWithHandoffTrace(session.page, generatedLargePdf.path);
        assertAtomicNativeToPdfjsHandoff(trace);
        await assertFinalPdfjsCapabilities(session.page, GENERATED_LARGE_PDF_PAGE_COUNT);
        await assertSkeletonFreePageJump(session.page, NAVIGATION_ACCEPTANCE_PAGE);
    }, LARGE_PDF_TIMEOUT_MS);

    it.skipIf(exactLargePdfPath.length === 0)(
        'hands the exact production dictionary to PDF.js without a navigation flash',
        async () => {
            const session = sessionFixture.getSession();
            if (!session) {
                throw new Error('Large-PDF Electron E2E session failed to start');
            }

            const trace = await openWithHandoffTrace(
                session.page,
                exactLargePdfPath,
                () => assertNativeOpeningPreviewIsViewable(session.page, EXACT_DICTIONARY_PAGE_COUNT),
            );
            assertAtomicNativeToPdfjsHandoff(trace);
            await assertFinalPdfjsCapabilities(session.page, EXACT_DICTIONARY_PAGE_COUNT, 4);
            await assertSkeletonFreePageJump(session.page, NAVIGATION_ACCEPTANCE_PAGE);
        },
        LARGE_PDF_TIMEOUT_MS,
    );
});
