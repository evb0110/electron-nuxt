import { decode } from 'fast-png';
import { delay } from 'es-toolkit/promise';
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
    installNativePdfOpeningSampler,
    openNativePdfPreviewInApp,
    openPdfInApp,
    readNativePdfPreviewLoadingState,
    readNativePdfPreviewState,
    stopNativePdfOpeningSampler,
    triggerOpenPathInApp,
    waitForNativePdfPreviewLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const largePdfFixture = resolveNativeLargePdfFixtureAvailability();
const largePdfDescribe = selectFixtureDescribe(describe, largePdfFixture);

interface IRectLike {
    height: number;
    left: number;
    top: number;
    width: number;
}

interface IViewportLike {
    height: number;
    width: number;
}

type TNativePdfLoadingSample = Awaited<ReturnType<typeof readNativePdfPreviewLoadingState>> & { contrast: ReturnType<typeof measurePngRectContrast>; };

function measurePngRectContrast(
    pngBuffer: Uint8Array,
    rect: IRectLike | null,
    viewport: IViewportLike,
) {
    const decoded = decode(pngBuffer);
    const channels = decoded.channels;
    const scaleX = decoded.width / Math.max(1, viewport.width);
    const scaleY = decoded.height / Math.max(1, viewport.height);
    const sampleRect = rect ?? {
        height: viewport.height,
        left: 0,
        top: 0,
        width: viewport.width,
    };
    const left = Math.max(0, Math.floor(sampleRect.left * scaleX));
    const top = Math.max(0, Math.floor(sampleRect.top * scaleY));
    const right = Math.min(decoded.width, Math.ceil((sampleRect.left + sampleRect.width) * scaleX));
    const bottom = Math.min(decoded.height, Math.ceil((sampleRect.top + sampleRect.height) * scaleY));
    const stride = Math.max(1, Math.floor(Math.min(right - left, bottom - top) / 96));
    let count = 0;
    let lumaSum = 0;
    let lumaSquaredSum = 0;
    let darkCount = 0;
    let nearWhiteCount = 0;

    for (let y = top; y < bottom; y += stride) {
        for (let x = left; x < right; x += stride) {
            const offset = (y * decoded.width + x) * channels;
            const red = Number(decoded.data[offset] ?? 0);
            const green = Number(decoded.data[offset + 1] ?? red);
            const blue = Number(decoded.data[offset + 2] ?? green);
            const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
            lumaSum += luma;
            lumaSquaredSum += luma * luma;
            if (luma < 210) {
                darkCount += 1;
            }
            if (luma >= 245) {
                nearWhiteCount += 1;
            }
            count += 1;
        }
    }

    const mean = count > 0 ? lumaSum / count : 255;
    const variance = count > 0 ? lumaSquaredSum / count - mean * mean : 0;
    return {
        darkRatio: count > 0 ? darkCount / count : 0,
        nearWhiteRatio: count > 0 ? nearWhiteCount / count : 1,
        stdLuma: Math.sqrt(Math.max(0, variance)),
    };
}

function firstRect(rects: Array<IRectLike | null>) {
    return rects.find((rect): rect is IRectLike => rect !== null) ?? null;
}

function rectsAreStable(rects: IRectLike[], tolerancePx: number) {
    const first = rects[0];
    if (!first) {
        return true;
    }

    return rects.every(rect => (
        Math.abs(rect.left - first.left) <= tolerancePx
        && Math.abs(rect.top - first.top) <= tolerancePx
        && Math.abs(rect.width - first.width) <= tolerancePx
        && Math.abs(rect.height - first.height) <= tolerancePx
    ));
}

largePdfDescribe('Electron E2E - Large PDF Native Preview', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-native-preview-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });

    it('opens an oversized path-backed PDF through native preview without PDF.js allocation failure', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Large-PDF Electron E2E session failed to start');
        }
        if (!largePdfFixture.path) {
            throw new Error(`Large-PDF fixture unavailable: ${largePdfFixture.reason}`);
        }

        const consoleFailures: string[] = [];
        session.page.on('console', (message) => {
            const text = message.text();
            if (/Array buffer allocation failed|No handler registered|Failed to load PDF|UnknownErrorException|RangeError/i.test(text)) {
                consoleFailures.push(text);
            }
        });

        await openNativePdfPreviewInApp(session.page, largePdfFixture.path, LARGE_PDF_TIMEOUT_MS);

        const state = await readNativePdfPreviewState(session.page);
        expect(state.nativeViewerVisible, JSON.stringify(state)).toBe(true);
        expect(state.standardPdfViewerVisible, JSON.stringify(state)).toBe(false);
        expect(state.visibleRenderedImages, JSON.stringify(state)).toBeGreaterThan(0);
        expect(state.renderedImageSizes.every(size => size.width > 0 && size.height > 0), JSON.stringify(state)).toBe(true);
        expect(state.renderedImageSizes.every(size => size.width >= size.requiredWidth), JSON.stringify(state)).toBe(true);
        expect(state.imageCountPerShell.every(count => count <= 1), JSON.stringify(state)).toBe(true);
        expect(state.openSurface, JSON.stringify(state)).toEqual({
            hasRender: true,
            hasViewport: true,
            phase: 'ready',
            presentation: 'committed',
        });
        expect(state.hostDocumentOpenFallbackCount, JSON.stringify(state)).toBe(0);
        expect(state.transitionSurfaceCount, JSON.stringify(state)).toBe(0);
        expect(state.placeholderCount, JSON.stringify(state)).toBe(0);
        expect(state.errorTexts, JSON.stringify(state)).toHaveLength(0);
        expect(state.crashText, JSON.stringify(state)).toBe('');
        expect(consoleFailures, JSON.stringify(state)).toHaveLength(0);
        expect(state.toolbar?.hasPdf, JSON.stringify(state)).toBe(true);
        expect(state.toolbar?.totalPages ?? 0, JSON.stringify(state)).toBeGreaterThan(1);
        expect(state.toolbar?.canRepairSave, JSON.stringify(state)).toBe(false);
        expect(state.toolbar?.canOptimizePdf, JSON.stringify(state)).toBe(false);
    }, LARGE_PDF_TIMEOUT_MS);

    it('keeps one coherent pending surface until the first native preview image is visible', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Large-PDF Electron E2E session failed to start');
        }
        if (!largePdfFixture.path) {
            throw new Error(`Large-PDF fixture unavailable: ${largePdfFixture.reason}`);
        }

        const priorPdfPath = await createMultiPageTextFixturePdf(
            `large-native-preview-prior-${Date.now()}.pdf`,
            2,
        );
        await openPdfInApp(session.page, priorPdfPath, LARGE_PDF_TIMEOUT_MS);
        await installNativePdfOpeningSampler(session.page);
        const openingStartedAtMs = await session.page.evaluate(() => performance.now());
        const samples: TNativePdfLoadingSample[] = [];
        let openingFrames: Awaited<ReturnType<typeof stopNativePdfOpeningSampler>> = [];
        try {
            await triggerOpenPathInApp(session.page, largePdfFixture.path, LARGE_PDF_TIMEOUT_MS);
            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                const state = await readNativePdfPreviewLoadingState(session.page);
                const screenshot = await session.page.screenshot({type: 'png'});
                samples.push({
                    ...state,
                    contrast: measurePngRectContrast(
                        screenshot,
                        firstRect(state.pageShellRects)
                        ?? state.transitionPageShellRect
                        ?? state.transitionSurfaceRect
                        ?? state.viewerRect
                        ?? state.workspaceSurfaceRect,
                        state.viewport,
                    ),
                });
                if (state.highResolutionVisibleRasterCount > 0) {
                    break;
                }
                await delay(100);
            }
        } finally {
            openingFrames = await stopNativePdfOpeningSampler(session.page);
        }

        const preContentSamples = samples.filter(sample => sample.highResolutionVisibleRasterCount === 0);
        // The toolbar announces the incoming document while the previously
        // committed PDF remains visible. Scope coarse loading assertions to
        // the first surface that belongs to the target open; rAF sampling
        // below supplies the mandatory, non-vacuous transition evidence when
        // a fast open falls entirely between the 100 ms coarse samples.
        const firstTargetSurfaceSampleIndex = preContentSamples.findIndex(sample => (
            sample.transitionSurfaceVisible
            || sample.nativeViewerVisible
        ));
        const preClaimSamples = firstTargetSurfaceSampleIndex < 0
            ? preContentSamples
            : preContentSamples.slice(0, firstTargetSurfaceSampleIndex);
        const claimedPreContentSamples = firstTargetSurfaceSampleIndex < 0
            ? []
            : preContentSamples.slice(firstTargetSurfaceSampleIndex);
        const nativeSkeletonSamples = claimedPreContentSamples.filter(sample => (
            sample.nativeViewerVisible
            && sample.visiblePageSkeletonCount > 0
        ));
        const topNativeSkeletonSamples = claimedPreContentSamples.filter(sample => sample.topPendingSurface === 'native');
        const topBlankPendingSamples = claimedPreContentSamples.filter(sample => (
            sample.topPendingSurface === 'none'
            && !sample.transitionSurfaceVisible
        ));
        const nativeViewerTopSurfaceSamples = claimedPreContentSamples.filter(sample => (
            sample.nativeViewerVisible
            && sample.topPendingSurface !== 'transition'
        ));
        const transitionSurfaceSamples = claimedPreContentSamples.filter(sample => sample.transitionSurfaceVisible);
        const skeletonSamples = claimedPreContentSamples.filter(sample => (
            sample.visiblePageSkeletonCount > 0
            || sample.visibleTransitionSkeletonCount > 0
        ));
        const blankPendingSamples = claimedPreContentSamples.filter(sample => (
            sample.visiblePageSkeletonCount === 0
            && sample.visibleTransitionSkeletonCount === 0
            && !sample.transitionSurfaceVisible
            && !sample.hostDocumentOpenFallbackVisible
        ));
        const staleEmptyStateSamples = claimedPreContentSamples.filter(sample => (
            sample.emptyStateVisible
            && /Recent Files|Choose a PDF|Choose History/i.test(sample.emptyStateText)
        ));
        const loadingShellRects = skeletonSamples
            .map(sample => firstRect(sample.pageShellRects) ?? sample.transitionPageShellRect)
            .filter((rect): rect is IRectLike => rect !== null);
        expect(preContentSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
        const firstTransitionFrameIndex = openingFrames.findIndex(frame => frame.transitionSurfaceVisible);
        const openingGeneration = openingFrames[firstTransitionFrameIndex]?.generation;
        const openingDocumentId = openingFrames[firstTransitionFrameIndex]?.documentId;
        const firstClaimedFrameIndex = openingFrames.findIndex(frame => (
            frame.claimed
            && frame.generation === openingGeneration
            && frame.documentId === openingDocumentId
        ));
        const firstCommittedFrameIndex = openingFrames.findIndex((frame, index) => (
            index > firstClaimedFrameIndex
            && frame.generation === openingGeneration
            && frame.documentId === openingDocumentId
            && frame.committedHighResolutionRasterVisible
        ));
        const claimedOpeningFrames = firstClaimedFrameIndex < 0
            ? []
            : openingFrames.slice(
                firstClaimedFrameIndex,
                firstCommittedFrameIndex < 0 ? undefined : firstCommittedFrameIndex,
            );
        const openingFrameRects = claimedOpeningFrames
            .map(frame => frame.transitionShellRect)
            .filter((rect): rect is IRectLike => rect !== null);
        expect(firstTransitionFrameIndex, JSON.stringify(openingFrames)).toBeGreaterThanOrEqual(0);
        expect(
            (openingFrames[firstTransitionFrameIndex]?.capturedAtMs ?? Number.POSITIVE_INFINITY)
            - openingStartedAtMs,
            JSON.stringify(openingFrames),
        ).toBeLessThan(1_000);
        expect(firstClaimedFrameIndex, JSON.stringify(openingFrames)).toBeGreaterThanOrEqual(0);
        expect(firstCommittedFrameIndex, JSON.stringify(openingFrames)).toBeGreaterThan(firstClaimedFrameIndex);
        expect(claimedOpeningFrames.length, JSON.stringify(openingFrames)).toBeGreaterThan(0);
        expect(openingFrames.every(frame => (
            !frame.committedLowResolutionRasterVisible
        )), JSON.stringify(openingFrames)).toBe(true);
        expect(claimedOpeningFrames.every(frame => (
            frame.transitionSurfaceVisible
            && frame.transitionSkeletonCount === 1
            && frame.transitionCoversViewport
            && !frame.emptyStateVisible
        )), JSON.stringify(openingFrames)).toBe(true);
        expect(
            claimedOpeningFrames.every(frame => !frame.nativeSkeletonVisible),
            JSON.stringify(openingFrames),
        ).toBe(true);
        expect(rectsAreStable(openingFrameRects, 0.5), JSON.stringify(openingFrames)).toBe(true);
        // Main-process preflight happens before the host claims its only visual
        // transaction. During that boundary the prior surface must remain
        // stable; the no-blank/skeleton obligation starts at canonical claim.
        expect(preClaimSamples.every(sample => (
            (
                sample.emptyStateVisible
                || sample.contrast.darkRatio >= 0.015
                || sample.contrast.stdLuma >= 8
            )
            && !sample.transitionSurfaceVisible
            && !sample.nativeViewerVisible
            && sample.topPendingSurface === 'none'
        )), JSON.stringify(samples)).toBe(true);
        expect(staleEmptyStateSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(claimedPreContentSamples.every(sample => sample.emptyStateVisible === false), JSON.stringify(samples)).toBe(true);
        // Slow preflight can supply an authoritative opening frame; the
        // immediate path deliberately uses the chassis' provisional shell.
        // Both must provide measured geometry for the one pending surface.
        expect(claimedPreContentSamples.every(sample => (
            (
                sample.openSurface.hasOpeningGeometry
                && sample.openSurface.hasOpeningFrame
            )
            || (
                sample.transitionSurfaceVisible
                && sample.transitionPageShellRect !== null
            )
        )), JSON.stringify(samples)).toBe(true);
        // Cold and prepared shells are implementation states, not additional
        // visual stages. Every visible opening shell presents the same
        // skeleton until the final native raster commits.
        expect(transitionSurfaceSamples.every(sample => (
            sample.visibleTransitionSkeletonCount === 1
        )), JSON.stringify(samples)).toBe(true);
        expect(transitionSurfaceSamples, JSON.stringify(samples)).toHaveLength(claimedPreContentSamples.length);
        expect(nativeViewerTopSurfaceSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(topNativeSkeletonSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(topBlankPendingSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(blankPendingSamples, JSON.stringify(samples)).toHaveLength(0);
        // The chassis owns the one pending visual. A second skeleton inside
        // the native feature pack would reintroduce the sequential/ambiguous
        // loading states this contract is intended to prevent.
        expect(nativeSkeletonSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(rectsAreStable(loadingShellRects, 0.5), JSON.stringify(samples)).toBe(true);
        expect(claimedPreContentSamples.every(sample => sample.toolbar?.isOpeningDocument === true), JSON.stringify(samples)).toBe(true);
        expect(claimedPreContentSamples.every(sample => (sample.toolbar?.totalPages ?? 0) >= 0), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.every(sample => sample.statusBarVisible), JSON.stringify(samples)).toBe(true);
        expect(claimedOpeningFrames.some(frame => frame.transitionSkeletonCount === 1), JSON.stringify(openingFrames)).toBe(true);
        expect(skeletonSamples.every(sample => (
            sample.statusFileName.length > 0
            && !/No file open|status\\.noFileOpen/i.test(sample.statusFileName)
        )), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.every(sample => (
            sample.contrast.darkRatio >= 0.015
            || sample.contrast.stdLuma >= 8
        )), JSON.stringify(samples)).toBe(true);
        expect(samples.every(sample => sample.lowResolutionVisibleRasterCount === 0), JSON.stringify(samples)).toBe(true);
        expect(samples.some(sample => sample.highResolutionVisibleRasterCount > 0), JSON.stringify(samples)).toBe(true);

        await waitForNativePdfPreviewLoaded(session.page, LARGE_PDF_TIMEOUT_MS);

        const settledSamples: TNativePdfLoadingSample[] = [];
        for (let index = 0; index < 24; index += 1) {
            const state = await readNativePdfPreviewLoadingState(session.page);
            const screenshot = await session.page.screenshot({type: 'png'});
            settledSamples.push({
                ...state,
                contrast: measurePngRectContrast(screenshot, state.viewerRect, state.viewport),
            });
            await delay(100);
        }

        expect(settledSamples.every(sample => sample.highResolutionVisibleRasterCount > 0), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => sample.lowResolutionVisibleRasterCount === 0), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => sample.pendingDecodedImages === 0), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.hostDocumentOpenFallbackVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.transitionSurfaceVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.emptyStateVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => (
            sample.contrast.darkRatio >= 0.015
            || sample.contrast.stdLuma >= 8
        )), JSON.stringify(settledSamples)).toBe(true);
    }, LARGE_PDF_TIMEOUT_MS);

    it('joins physical mouse-wheel scrolling to the native raster and viewport authority', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Large-PDF Electron E2E session failed to start');
        }
        if (!largePdfFixture.path) {
            throw new Error(`Large-PDF fixture unavailable: ${largePdfFixture.reason}`);
        }

        let initial = await readNativePdfPreviewState(session.page);
        if (!initial.nativeViewerVisible || initial.visibleRenderedImages === 0) {
            await openNativePdfPreviewInApp(session.page, largePdfFixture.path, LARGE_PDF_TIMEOUT_MS);
            initial = await readNativePdfPreviewState(session.page);
        }
        const totalPages = initial.toolbar?.totalPages ?? 1;
        const targetPage = Math.min(5, totalPages - 1);
        expect(targetPage).toBeGreaterThan(1);
        const physicalWheelMinimumPage = Math.min(targetPage + 3, totalPages);
        expect(physicalWheelMinimumPage).toBeGreaterThan(targetPage);

        const command = await callWorkspaceCommand(session.page, 'handleGoToPage', [targetPage]);
        expect(command.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {currentPage: targetPage},
            {timeoutMs: 30_000},
        );
        try {
            await waitForFunctionInPage(session.page, (pageNumber: number) => {
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
                const viewport = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
                const shell = host?.querySelector<HTMLElement>(
                    `.native-pdf-page-shell[data-page-number="${String(pageNumber)}"]`,
                ) ?? null;
                const image = shell?.querySelector<HTMLImageElement>('.native-pdf-page-image') ?? null;
                const shellRect = shell?.getBoundingClientRect() ?? null;
                const viewportRect = viewport?.getBoundingClientRect() ?? null;
                return chassis?.dataset.viewportRequestedPage === String(pageNumber)
                    && chassis.dataset.viewportCommittedPage === String(pageNumber)
                    && viewport?.dataset.openSurfacePhase === 'ready'
                    && shell?.querySelector('.document-page-visual--committed') !== null
                    && image?.complete === true
                    && (image.naturalWidth ?? 0) > 0
                    && shellRect !== null
                    && viewportRect !== null
                    && shellRect.bottom > viewportRect.top
                    && shellRect.top < viewportRect.bottom
                    && host?.querySelectorAll('.native-pdf-page-shell .document-page-skeleton').length === 0;
            }, {timeout: 30_000}, targetPage);
        } catch (error) {
            const navigationState = await session.page.evaluate((pageNumber) => {
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
                const viewport = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
                const shells = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell') ?? []);
                return {
                    requestedPage: chassis?.dataset.viewportRequestedPage ?? null,
                    committedPage: chassis?.dataset.viewportCommittedPage ?? null,
                    phase: viewport?.dataset.openSurfacePhase ?? null,
                    scrollTop: viewport?.scrollTop ?? null,
                    skeletons: host?.querySelectorAll('.native-pdf-page-shell .document-page-skeleton').length ?? 0,
                    shells: shells.map(shell => ({
                        pageNumber: shell.dataset.pageNumber ?? null,
                        committed: shell.querySelector('.document-page-visual--committed') !== null,
                        hasImage: shell.querySelector<HTMLImageElement>('.native-pdf-page-image')?.complete ?? false,
                        rectTop: shell.getBoundingClientRect().top,
                    })),
                    targetPage: pageNumber,
                };
            }, targetPage);
            throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(navigationState)}`);
        }

        // Replaying an already-current page is a real toolbar/checkpoint path.
        // It must not leave a programmatic navigation fence that suppresses
        // the next physical-scroll page projection.
        const samePageReplay = await callWorkspaceCommand(session.page, 'handleGoToPage', [targetPage]);
        expect(samePageReplay.called).toBe(true);

        const viewportCenter = await session.page.evaluate(() => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const viewport = host?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            const rect = viewport?.getBoundingClientRect() ?? null;
            return rect ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                scrollTop: viewport?.scrollTop ?? 0,
            } : null;
        });
        if (!viewportCenter) {
            throw new Error('Expected a visible native PDF viewport for physical wheel input');
        }
        await session.page.mouse.move(viewportCenter.x, viewportCenter.y);
        let previousObservedPage = targetPage;
        let previousScrollTop = viewportCenter.scrollTop;
        let stalledIterations = 0;
        interface IPhysicalWheelProjection {
            chassisCurrentPage: number | null;
            observedPage: number | null;
            scrollTop: number;
            toolbarCurrentPage: number | null;
        }
        let physicalWheelProjection: IPhysicalWheelProjection | null = null;
        const physicalWheelProjectionTrace: IPhysicalWheelProjection[] = [];
        for (let index = 0; index < 48; index += 1) {
            await session.page.mouse.wheel({deltaY: 800});
            await delay(100);
            physicalWheelProjection = await session.page.evaluate(() => {
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
                const viewport = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
                const parsePage = (value: string | undefined) => {
                    const page = Number(value);
                    return Number.isSafeInteger(page) && page > 0 ? page : null;
                };
                return {
                    chassisCurrentPage: parsePage(chassis?.dataset.chassisCurrentPage),
                    observedPage: parsePage(chassis?.dataset.viewportObservedPage),
                    scrollTop: viewport?.scrollTop ?? 0,
                    toolbarCurrentPage: window.__evbTestApi?.getActiveToolbarSnapshot()?.currentPage ?? null,
                };
            });
            physicalWheelProjectionTrace.push(physicalWheelProjection);
            if (physicalWheelProjection.observedPage !== null) {
                expect(physicalWheelProjection.chassisCurrentPage, JSON.stringify(physicalWheelProjectionTrace))
                    .toBe(physicalWheelProjection.observedPage);
                expect(physicalWheelProjection.toolbarCurrentPage, JSON.stringify(physicalWheelProjectionTrace))
                    .toBe(physicalWheelProjection.observedPage);
            }
            if (
                physicalWheelProjection.observedPage !== null
                && physicalWheelProjection.observedPage !== previousObservedPage
            ) {
                expect(physicalWheelProjection.observedPage, JSON.stringify(physicalWheelProjectionTrace))
                    .toBeGreaterThan(previousObservedPage);
                previousObservedPage = physicalWheelProjection.observedPage;
            }
            if ((physicalWheelProjection.observedPage ?? 0) >= physicalWheelMinimumPage) {
                break;
            }
            if (physicalWheelProjection.scrollTop > previousScrollTop + 0.5) {
                stalledIterations = 0;
            } else {
                stalledIterations += 1;
            }
            if (stalledIterations >= 3) {
                break;
            }
            previousScrollTop = physicalWheelProjection.scrollTop;
        }
        const physicalWheelState = await readNativePdfPreviewState(session.page);
        expect(physicalWheelProjection?.observedPage ?? 0, JSON.stringify({
            physicalWheelProjection,
            physicalWheelProjectionTrace,
            physicalWheelState,
        })).toBeGreaterThanOrEqual(physicalWheelMinimumPage);
        const toolbarPageTrace = physicalWheelProjectionTrace
            .map(sample => sample.toolbarCurrentPage)
            .filter((page): page is number => page !== null);
        expect(toolbarPageTrace, JSON.stringify(physicalWheelProjectionTrace)).toEqual(
            [...toolbarPageTrace].sort((left, right) => left - right),
        );
        const physicalWheelPage = physicalWheelProjection!.observedPage!;
        await waitForFunctionInPage(session.page, ({
            pageNumber,
            previousScrollTop,
        }) => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            const viewport = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            const shell = host?.querySelector<HTMLElement>(
                `.native-pdf-page-shell[data-page-number="${String(pageNumber)}"]`,
            ) ?? null;
            const shellRect = shell?.getBoundingClientRect() ?? null;
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            return chassis?.dataset.chassisCurrentPage === String(pageNumber)
                && chassis.dataset.viewportObservedPage === String(pageNumber)
                && (viewport?.scrollTop ?? 0) > previousScrollTop
                && shell?.querySelector('.document-page-visual--committed') !== null
                && shellRect !== null
                && viewportRect !== null
                && shellRect.bottom > viewportRect.top
                && shellRect.top < viewportRect.bottom;
        }, {timeout: 30_000}, {
            pageNumber: physicalWheelPage,
            previousScrollTop: viewportCenter.scrollTop,
        });

        const settled = await readNativePdfPreviewState(session.page);
        expect(settled.openSurface, JSON.stringify(settled)).toEqual({
            hasRender: true,
            hasViewport: true,
            phase: 'ready',
            presentation: 'committed',
        });
        expect(settled.skeletonCount, JSON.stringify(settled)).toBe(0);
        expect(settled.errorTexts, JSON.stringify(settled)).toHaveLength(0);
    }, LARGE_PDF_TIMEOUT_MS);

    it('keeps the native PDF point beneath the pointer fixed during wheel zoom', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            throw new Error('Large-PDF Electron E2E session failed to start');
        }
        if (!largePdfFixture.path) {
            throw new Error(`Large-PDF fixture unavailable: ${largePdfFixture.reason}`);
        }

        await openNativePdfPreviewInApp(session.page, largePdfFixture.path, LARGE_PDF_TIMEOUT_MS);
        const totalPages = (await readNativePdfPreviewState(session.page)).toolbar?.totalPages ?? 0;
        expect(totalPages).toBeGreaterThanOrEqual(3);
        const pageNumber = 3;
        const navigation = await callWorkspaceCommand(session.page, 'handleGoToPage', [pageNumber]);
        expect(navigation.called).toBe(true);
        const zoom = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [3.76]);
        expect(zoom.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                currentPage: pageNumber,
                minEffectiveZoom: 3.75,
                zoomMode: 'custom',
            },
            {timeoutMs: 30_000},
        );
        await waitForNativePdfPreviewLoaded(session.page, LARGE_PDF_TIMEOUT_MS);

        const anchor = await session.page.evaluate((targetPage) => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const viewport = host?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
            const shell = host?.querySelector<HTMLElement>(
                `.native-pdf-page-shell[data-page-number="${String(targetPage)}"]`,
            ) ?? null;
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            const shellRect = shell?.getBoundingClientRect() ?? null;
            if (!viewport || !viewportRect || !shellRect) {
                return null;
            }
            const visibleLeft = Math.max(viewportRect.left, shellRect.left);
            const visibleRight = Math.min(viewportRect.right, shellRect.right);
            const visibleTop = Math.max(viewportRect.top, shellRect.top);
            const visibleBottom = Math.min(viewportRect.bottom, shellRect.bottom);
            if (visibleRight - visibleLeft < 40 || visibleBottom - visibleTop < 40) {
                return null;
            }
            const x = visibleLeft + (visibleRight - visibleLeft) * 0.3;
            const y = visibleTop + (visibleBottom - visibleTop) * 0.4;
            return {
                pageNumber: targetPage,
                pageXRatio: (x - shellRect.left) / shellRect.width,
                pageYRatio: (y - shellRect.top) / shellRect.height,
                x,
                y,
                zoom: window.__evbTestApi?.getActiveToolbarSnapshot()?.effectiveZoom ?? null,
            };
        }, pageNumber);
        expect(anchor).not.toBeNull();
        if (!anchor) {
            return;
        }

        const readAnchorState = () => session.page.evaluate(({
            pageNumber: targetPage,
            pageXRatio,
            pageYRatio,
            x,
            y,
        }) => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const shell = host?.querySelector<HTMLElement>(
                `.native-pdf-page-shell[data-page-number="${String(targetPage)}"]`,
            ) ?? null;
            const rect = shell?.getBoundingClientRect() ?? null;
            return {
                anchorErrorX: rect ? rect.left + rect.width * pageXRatio - x : null,
                anchorErrorY: rect ? rect.top + rect.height * pageYRatio - y : null,
                targetPageSkeletonCount: shell?.querySelectorAll('.document-page-skeleton').length ?? 0,
                zoom: window.__evbTestApi?.getActiveToolbarSnapshot()?.effectiveZoom ?? null,
            };
        }, anchor);
        type TAnchorState = Awaited<ReturnType<typeof readAnchorState>>;
        const waitForConvergedAnchorState = async (previousZoom: number, direction: 'in' | 'out') => {
            await waitForFunctionInPage(session.page, ({
                direction: zoomDirection,
                pageNumber: targetPage,
                pageXRatio,
                pageYRatio,
                previousZoom: priorZoom,
                x,
                y,
            }) => {
                const host = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
                ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
                const shell = host?.querySelector<HTMLElement>(
                    `.native-pdf-page-shell[data-page-number="${String(targetPage)}"]`,
                ) ?? null;
                const rect = shell?.getBoundingClientRect() ?? null;
                const zoom = window.__evbTestApi?.getActiveToolbarSnapshot()?.effectiveZoom ?? null;
                return rect !== null
                    && zoom !== null
                    && (zoomDirection === 'in' ? zoom > priorZoom : zoom < priorZoom)
                    && Math.abs(rect.left + rect.width * pageXRatio - x) <= 2
                    && Math.abs(rect.top + rect.height * pageYRatio - y) <= 2;
            }, {
                polling: 'raf',
                timeout: 150,
            }, {
                ...anchor,
                direction,
                previousZoom,
            });
            return readAnchorState();
        };

        const isMac = await session.page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform));
        await session.page.mouse.move(anchor.x, anchor.y);
        const modifierKey = isMac ? 'Meta' : 'Control';
        const zoomInSamples: TAnchorState[] = [];
        await session.page.keyboard.down(modifierKey);
        try {
            let previousZoom = anchor.zoom ?? 0;
            for (let index = 0; index < 5; index += 1) {
                await session.page.mouse.wheel({deltaY: -24});
                const sample = await waitForConvergedAnchorState(previousZoom, 'in');
                zoomInSamples.push(sample);
                previousZoom = sample.zoom ?? previousZoom;
            }
        } finally {
            await session.page.keyboard.up(modifierKey);
        }
        zoomInSamples.forEach((sample, index) => {
            expect(Math.abs(sample.anchorErrorX ?? Number.POSITIVE_INFINITY), JSON.stringify({
                index,
                zoomInSamples,
            })).toBeLessThanOrEqual(2);
            expect(Math.abs(sample.anchorErrorY ?? Number.POSITIVE_INFINITY), JSON.stringify({
                index,
                zoomInSamples,
            })).toBeLessThanOrEqual(2);
            if (index > 0) {
                expect(sample.zoom ?? 0, JSON.stringify(zoomInSamples)).toBeGreaterThan(zoomInSamples[index - 1]?.zoom ?? Number.POSITIVE_INFINITY);
            }
        });
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minEffectiveZoom: (anchor.zoom ?? 0) + 0.5},
            {timeoutMs: 10_000},
        );
        await waitForFunctionInPage(session.page, ({
            pageNumber: targetPage,
            pageXRatio,
            pageYRatio,
            x,
            y,
        }) => {
            const host = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const shell = host?.querySelector<HTMLElement>(
                `.native-pdf-page-shell[data-page-number="${String(targetPage)}"]`,
            ) ?? null;
            const rect = shell?.getBoundingClientRect() ?? null;
            return rect !== null
                && shell?.querySelector('.document-page-visual--committed') !== null
                && shell?.querySelector('.document-page-skeleton') === null
                && Math.abs(rect.left + rect.width * pageXRatio - x) <= 2
                && Math.abs(rect.top + rect.height * pageYRatio - y) <= 2;
        }, {timeout: 10_000}, anchor);

        const settled = await readAnchorState();
        expect(Math.abs(settled.anchorErrorX ?? Number.POSITIVE_INFINITY), JSON.stringify(settled)).toBeLessThanOrEqual(2);
        expect(Math.abs(settled.anchorErrorY ?? Number.POSITIVE_INFINITY), JSON.stringify(settled)).toBeLessThanOrEqual(2);
        expect(settled.targetPageSkeletonCount, JSON.stringify(settled)).toBe(0);
        expect(settled.zoom, JSON.stringify(settled)).toBeGreaterThan(anchor.zoom ?? 0);

        const zoomOutSamples: TAnchorState[] = [];
        await session.page.keyboard.down(modifierKey);
        try {
            let previousZoom = settled.zoom ?? Number.POSITIVE_INFINITY;
            for (let index = 0; index < 5; index += 1) {
                await session.page.mouse.wheel({deltaY: 24});
                const sample = await waitForConvergedAnchorState(previousZoom, 'out');
                zoomOutSamples.push(sample);
                previousZoom = sample.zoom ?? previousZoom;
            }
        } finally {
            await session.page.keyboard.up(modifierKey);
        }
        zoomOutSamples.forEach((sample, index) => {
            expect(Math.abs(sample.anchorErrorX ?? Number.POSITIVE_INFINITY), JSON.stringify({
                index,
                zoomOutSamples,
            })).toBeLessThanOrEqual(2);
            expect(Math.abs(sample.anchorErrorY ?? Number.POSITIVE_INFINITY), JSON.stringify({
                index,
                zoomOutSamples,
            })).toBeLessThanOrEqual(2);
            if (index > 0) {
                expect(sample.zoom ?? Number.POSITIVE_INFINITY, JSON.stringify(zoomOutSamples)).toBeLessThan(zoomOutSamples[index - 1]?.zoom ?? 0);
            }
        });
        expect(Math.abs((zoomOutSamples.at(-1)?.zoom ?? 0) - (anchor.zoom ?? 0)), JSON.stringify(zoomOutSamples)).toBeLessThan(0.02);
    }, LARGE_PDF_TIMEOUT_MS);
});
