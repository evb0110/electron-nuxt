import { statSync } from 'node:fs';
import { decode } from 'fast-png';
import { delay } from 'es-toolkit/promise';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { PDFJS_NATIVE_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/runtime/pdfNativePreviewRouting';
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
            reason: `Native large PDF fixture is ${formatBytes(size)}; native preview E2E requires at least ${formatBytes(PDFJS_NATIVE_PREVIEW_MIN_BYTES)}. Set EVB_E2E_LARGE_PDF_FIXTURE to an oversized PDF and ${NATIVE_LARGE_PDF_REQUIRE_ENV_VAR}=1 to require this lane.`,
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
        expect(state.renderedImages, JSON.stringify(state)).toBeGreaterThan(0);
        expect(state.renderedImageSizes.every(size => size.width > 0 && size.height > 0), JSON.stringify(state)).toBe(true);
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
                    ?? state.viewerRect,
                    state.viewport,
                ),
            });

            if (state.renderedImages > 0) {
                break;
            }
            await delay(500);
        }

        const preContentSamples = samples.filter(sample => sample.renderedImages === 0);
        const nativeSkeletonSamples = preContentSamples.filter(sample => (
            sample.nativeViewerVisible
            && sample.visiblePageSkeletonCount > 0
        ));
        const topNativeSkeletonSamples = preContentSamples.filter(sample => sample.topPendingSurface === 'native');
        const topBlankPendingSamples = preContentSamples.filter(sample => (
            sample.topPendingSurface === 'none'
            && !sample.transitionSurfaceVisible
        ));
        const nativeViewerTopSurfaceSamples = preContentSamples.filter(sample => (
            sample.nativeViewerVisible
            && sample.topPendingSurface !== 'transition'
        ));
        const transitionSurfaceSamples = preContentSamples.filter(sample => sample.transitionSurfaceVisible);
        const skeletonSamples = preContentSamples.filter(sample => (
            sample.visiblePageSkeletonCount > 0
            || sample.visibleTransitionSkeletonCount > 0
        ));
        const blankPendingSamples = preContentSamples.filter(sample => (
            sample.visiblePageSkeletonCount === 0
            && sample.visibleTransitionSkeletonCount === 0
            && !sample.transitionSurfaceVisible
            && !sample.hostDocumentOpenFallbackVisible
        ));
        const staleEmptyStateSamples = samples.filter((sample, index) => (
            index >= 2
            && sample.emptyStateVisible
            && /Recent Files|Choose a PDF|Choose History/i.test(sample.emptyStateText)
        ));
        const nativeShellRects = nativeSkeletonSamples
            .map(sample => firstRect(sample.pageShellRects))
            .filter((rect): rect is IRectLike => rect !== null);
        const loadingShellRects = skeletonSamples
            .map(sample => firstRect(sample.pageShellRects) ?? sample.transitionPageShellRect)
            .filter((rect): rect is IRectLike => rect !== null);
        expect(preContentSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
        expect(staleEmptyStateSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(preContentSamples.every(sample => sample.emptyStateVisible === false), JSON.stringify(samples)).toBe(true);
        expect(transitionSurfaceSamples.every(sample => sample.visibleTransitionSkeletonCount > 0), JSON.stringify(samples)).toBe(true);
        expect(nativeViewerTopSurfaceSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(topNativeSkeletonSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(topBlankPendingSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(skeletonSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
        expect(blankPendingSamples, JSON.stringify(samples)).toHaveLength(0);
        expect(nativeSkeletonSamples.length, JSON.stringify(samples)).toBeGreaterThan(0);
        expect(rectsAreStable(loadingShellRects, 3), JSON.stringify(samples)).toBe(true);
        expect(rectsAreStable(nativeShellRects, 3), JSON.stringify(samples)).toBe(true);
        expect(preContentSamples.every(sample => sample.toolbar?.isOpeningDocument === true), JSON.stringify(samples)).toBe(true);
        expect(preContentSamples.every(sample => (sample.toolbar?.totalPages ?? 0) >= 0), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.every(sample => sample.statusBarVisible), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.every(sample => (
            sample.statusFileName.length > 0
            && !/No file open|status\\.noFileOpen/i.test(sample.statusFileName)
        )), JSON.stringify(samples)).toBe(true);
        expect(skeletonSamples.some(sample => (
            sample.contrast.darkRatio >= 0.015
            || sample.contrast.stdLuma >= 8
        )), JSON.stringify(samples)).toBe(true);

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

        expect(settledSamples.every(sample => sample.renderedImages > 0), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.hostDocumentOpenFallbackVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.transitionSurfaceVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => !sample.emptyStateVisible), JSON.stringify(settledSamples)).toBe(true);
        expect(settledSamples.every(sample => (
            sample.contrast.darkRatio >= 0.015
            || sample.contrast.stdLuma >= 8
        )), JSON.stringify(settledSamples)).toBe(true);
    }, LARGE_PDF_TIMEOUT_MS);
});
