import { statSync } from 'node:fs';
import { decode } from 'fast-png';
import { delay } from 'es-toolkit/promise';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { PDFJS_NATIVE_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';
import {
    type IFixtureAvailability,
    resolveLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openNativePdfPreviewInApp,
    readNativePdfPreviewLoadingState,
    readNativePdfPreviewState,
    triggerOpenPathInApp,
    waitForNativePdfPreviewLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const NATIVE_LARGE_PDF_REQUIRE_ENV_VAR = 'EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE';
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

function isNativeLargePdfFixtureRequired() {
    return process.env[NATIVE_LARGE_PDF_REQUIRE_ENV_VAR] === '1';
}

function formatBytes(value: number) {
    const mib = value / 1024 / 1024;
    return `${Math.round(mib * 10) / 10} MiB`;
}

function resolveNativeLargePdfFixtureAvailability(): IFixtureAvailability {
    const fixture = resolveLargePdfFixtureAvailability();
    const required = isNativeLargePdfFixtureRequired();
    if (!fixture.path) {
        return {
            ...fixture,
            required,
        };
    }

    const size = statSync(fixture.path).size;
    if (size < PDFJS_NATIVE_PREVIEW_MIN_BYTES) {
        return {
            path: null,
            reason: `Native large PDF fixture is ${formatBytes(size)}; native preview E2E requires at least ${formatBytes(PDFJS_NATIVE_PREVIEW_MIN_BYTES)}. Set EVB_E2E_LARGE_PDF_FIXTURE to an oversized PDF (generate one in under a second with scripts/generate-large-pdf-e2e-fixture.mjs) and ${NATIVE_LARGE_PDF_REQUIRE_ENV_VAR}=1 to require this lane.`,
            required,
        };
    }

    return {
        path: fixture.path,
        reason: `Using native large PDF fixture: ${fixture.path} (${formatBytes(size)})`,
        required,
    };
}

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
        if (!session || !largePdfFixture.path) {
            return;
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
        if (!session || !largePdfFixture.path) {
            return;
        }

        await triggerOpenPathInApp(session.page, largePdfFixture.path, LARGE_PDF_TIMEOUT_MS);

        const samples: TNativePdfLoadingSample[] = [];
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

            if (state.visibleRenderedImages > 0) {
                break;
            }
            await delay(500);
        }

        const preContentSamples = samples.filter(sample => sample.visibleRenderedImages === 0);
        const firstClaimedSampleIndex = preContentSamples.findIndex(sample => sample.openSurface.claimed);
        const preClaimSamples = firstClaimedSampleIndex < 0
            ? preContentSamples
            : preContentSamples.slice(0, firstClaimedSampleIndex);
        const claimedPreContentSamples = firstClaimedSampleIndex < 0
            ? []
            : preContentSamples.slice(firstClaimedSampleIndex);
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
        // A warm native preview can cross claim -> committed raster between
        // polling samples. The skeleton is deliberately debounced, so that
        // fast path must not be forced to paint a pending intermediate state.
        expect(
            firstClaimedSampleIndex >= 0
            || samples.some(sample => sample.openSurface.phase === 'ready' && sample.visibleRenderedImages > 0),
            JSON.stringify(samples),
        ).toBe(true);
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
        expect(claimedPreContentSamples.every(sample => (
            sample.openSurface.hasOpeningGeometry
            && sample.openSurface.hasOpeningFrame
        )), JSON.stringify(samples)).toBe(true);
        expect(transitionSurfaceSamples.every(sample => sample.visibleTransitionSkeletonCount === 1), JSON.stringify(samples)).toBe(true);
        expect(nativeViewerTopSurfaceSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(topNativeSkeletonSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(topBlankPendingSamples, JSON.stringify(samples)).toHaveLength(0);
        if (claimedPreContentSamples.length > 0) {
            expect(skeletonSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
        }
        expect(blankPendingSamples, JSON.stringify(samples)).toHaveLength(0);
        // The chassis owns the one pending visual. A second skeleton inside
        // the native feature pack would reintroduce the sequential/ambiguous
        // loading states this contract is intended to prevent.
        expect(nativeSkeletonSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(rectsAreStable(loadingShellRects, 0.5), JSON.stringify(samples)).toBe(true);
        expect(claimedPreContentSamples.every(sample => sample.toolbar?.isOpeningDocument === true), JSON.stringify(samples)).toBe(true);
        expect(claimedPreContentSamples.every(sample => (sample.toolbar?.totalPages ?? 0) >= 0), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.every(sample => sample.statusBarVisible), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.every(sample => (
            sample.statusFileName.length > 0
            && !/No file open|status\\.noFileOpen/i.test(sample.statusFileName)
        )), JSON.stringify(samples)).toBe(true);
        if (skeletonSamples.length > 0) {
            expect(skeletonSamples.some(sample => (
                sample.contrast.darkRatio >= 0.015
                || sample.contrast.stdLuma >= 8
            )), JSON.stringify(samples)).toBe(true);
        }

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

        expect(settledSamples.every(sample => sample.visibleRenderedImages > 0), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => sample.pendingDecodedImages === 0), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.hostDocumentOpenFallbackVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.transitionSurfaceVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.emptyStateVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => (
            sample.contrast.darkRatio >= 0.015
            || sample.contrast.stdLuma >= 8
        )), JSON.stringify(settledSamples)).toBe(true);
    }, LARGE_PDF_TIMEOUT_MS);

    it('joins post-open navigation to the physical native raster and viewport intent', async () => {
        const session = sessionFixture.getSession();
        if (!session || !largePdfFixture.path) {
            return;
        }

        let initial = await readNativePdfPreviewState(session.page);
        if (!initial.nativeViewerVisible || initial.visibleRenderedImages === 0) {
            await openNativePdfPreviewInApp(session.page, largePdfFixture.path, LARGE_PDF_TIMEOUT_MS);
            initial = await readNativePdfPreviewState(session.page);
        }
        const targetPage = Math.min(5, initial.toolbar?.totalPages ?? 1);
        expect(targetPage).toBeGreaterThan(1);

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
});
