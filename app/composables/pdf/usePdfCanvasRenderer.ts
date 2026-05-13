import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { PDFOperatorList } from 'pdfjs-dist/types/src/display/api';

interface ICanvasRenderResult {
    canvas: HTMLCanvasElement;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    annotationCanvasMap: Map<string, HTMLCanvasElement>;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number;
    };
    userUnit: number;
    totalScaleFactor: number;
}

interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
}

interface IPreparedCanvasRender extends ICanvasRenderResult { startRender: () => ICancelableRenderTask; }

interface IRenderCanvasOptions {
    maxCanvasPixels?: number;
    onRenderTask?: (task: ICancelableRenderTask) => void;
    hiddenAnnotationIds?: Set<string>;
}

interface ICanvasPixelSize {
    pixelWidth: number;
    pixelHeight: number;
}

interface ICanvasScale {
    scaleX: number;
    scaleY: number;
}

interface IHiddenAnnotationScanState {
    skippedIndices: Set<number>;
    annotationStack: boolean[];
    hiddenDepth: number;
}

const BEGIN_ANNOTATION_OP = 80;
const END_ANNOTATION_OP = 81;

export const usePdfCanvasRenderer = (deps: { outputScale: number }) => {
    const { outputScale } = deps;
    const hiddenAnnotationOperationsFilterCache = new WeakMap<
        PDFPageProxy,
        Map<string, ((index: number) => boolean) | null>
    >();

    function normalizeAnnotationIdSet(annotationIds: Set<string>) {
        const normalizedIds = new Set<string>();
        annotationIds.forEach((id) => {
            const normalizedId = normalizePdfJsAnnotationId(id);
            if (normalizedId) {
                normalizedIds.add(normalizedId);
            }
        });
        return normalizedIds;
    }

    function collectHiddenAnnotationOperatorIndices(
        operatorList: PDFOperatorList,
        hiddenAnnotationIds: Set<string>,
    ) {
        if (hiddenAnnotationIds.size === 0) {
            return new Set<number>();
        }

        const state: IHiddenAnnotationScanState = {
            skippedIndices: new Set<number>(),
            annotationStack: [],
            hiddenDepth: 0,
        };

        for (const [
            index,
            fn,
        ] of operatorList.fnArray.entries()) {
            if (fn === BEGIN_ANNOTATION_OP) {
                processBeginAnnotationOperator(
                    state,
                    operatorList.argsArray[index],
                    index,
                    hiddenAnnotationIds,
                );
                continue;
            }

            if (state.hiddenDepth > 0) {
                state.skippedIndices.add(index);
            }

            if (fn === END_ANNOTATION_OP) {
                processEndAnnotationOperator(state);
            }
        }

        return state.skippedIndices;
    }

    function processBeginAnnotationOperator(
        state: IHiddenAnnotationScanState,
        args: unknown,
        index: number,
        hiddenAnnotationIds: Set<string>,
    ) {
        const annotationId = Array.isArray(args) && typeof args[0] === 'string'
            ? normalizePdfJsAnnotationId(args[0])
            : null;
        const isHidden = annotationId ? hiddenAnnotationIds.has(annotationId) : false;

        if (state.hiddenDepth > 0 || isHidden) {
            state.skippedIndices.add(index);
        }

        state.annotationStack.push(isHidden);
        if (isHidden) {
            state.hiddenDepth += 1;
        }
    }

    function processEndAnnotationOperator(state: IHiddenAnnotationScanState) {
        const didHideCurrentAnnotation = state.annotationStack.pop() ?? false;
        if (didHideCurrentAnnotation) {
            state.hiddenDepth = Math.max(0, state.hiddenDepth - 1);
        }
    }

    function getHiddenAnnotationFilterCacheKey(
        annotationMode: number,
        normalizedHiddenAnnotationIds: Set<string>,
    ) {
        return `${annotationMode}:${[...normalizedHiddenAnnotationIds].sort((left, right) => left.localeCompare(right)).join('\u0000')}`;
    }

    async function createHiddenAnnotationOperationsFilter(
        pdfPage: PDFPageProxy,
        annotationMode: number,
        hiddenAnnotationIds?: Set<string>,
    ) {
        if (!hiddenAnnotationIds || hiddenAnnotationIds.size === 0) {
            return undefined;
        }

        if (typeof pdfPage.getOperatorList !== 'function') {
            return undefined;
        }

        try {
            const normalizedHiddenAnnotationIds = normalizeAnnotationIdSet(hiddenAnnotationIds);
            if (normalizedHiddenAnnotationIds.size === 0) {
                return undefined;
            }

            const cacheKey = getHiddenAnnotationFilterCacheKey(
                annotationMode,
                normalizedHiddenAnnotationIds,
            );
            const cachedFilters = hiddenAnnotationOperationsFilterCache.get(pdfPage);
            if (cachedFilters?.has(cacheKey)) {
                return cachedFilters.get(cacheKey) ?? undefined;
            }

            const operatorList = await pdfPage.getOperatorList({ annotationMode });
            const skippedIndices = collectHiddenAnnotationOperatorIndices(
                operatorList,
                normalizedHiddenAnnotationIds,
            );

            if (skippedIndices.size === 0) {
                const nextCachedFilters = cachedFilters ?? new Map<string, ((index: number) => boolean) | null>();
                nextCachedFilters.set(cacheKey, null);
                hiddenAnnotationOperationsFilterCache.set(pdfPage, nextCachedFilters);
                return undefined;
            }

            const operationsFilter = (index: number) => !skippedIndices.has(index);
            const nextCachedFilters = cachedFilters ?? new Map<string, ((index: number) => boolean) | null>();
            nextCachedFilters.set(cacheKey, operationsFilter);
            hiddenAnnotationOperationsFilterCache.set(pdfPage, nextCachedFilters);
            return operationsFilter;
        } catch (error) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Failed to build hidden annotation filter for page ${pdfPage.pageNumber}`,
                error,
            );
            return undefined;
        }
    }

    function cleanupCanvas(canvas: HTMLCanvasElement) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    }

    function isValidViewportSize(width: number, height: number) {
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    }

    function getMaxCanvasPixels(options?: IRenderCanvasOptions) {
        return typeof options?.maxCanvasPixels === 'number'
            && Number.isFinite(options.maxCanvasPixels)
            && options.maxCanvasPixels > 0
            ? Math.max(1, Math.round(options.maxCanvasPixels))
            : null;
    }

    function calculateCanvasPixelSize(
        cssWidth: number,
        cssHeight: number,
        options?: IRenderCanvasOptions,
    ): ICanvasPixelSize {
        const requestedPixelWidth = Math.max(1, Math.round(cssWidth * outputScale));
        const requestedPixelHeight = Math.max(1, Math.round(cssHeight * outputScale));
        const requestedPixelCount = requestedPixelWidth * requestedPixelHeight;
        const maxCanvasPixels = getMaxCanvasPixels(options);
        const shouldClampPixels = maxCanvasPixels !== null && requestedPixelCount > maxCanvasPixels;
        const pixelScaleFactor = shouldClampPixels
            ? Math.sqrt(maxCanvasPixels / requestedPixelCount)
            : 1;

        return {
            pixelWidth: Math.max(1, Math.round(requestedPixelWidth * pixelScaleFactor)),
            pixelHeight: Math.max(1, Math.round(requestedPixelHeight * pixelScaleFactor)),
        };
    }

    function setupCanvas(
        canvas: HTMLCanvasElement,
        cssWidth: number,
        cssHeight: number,
        pixelSize: ICanvasPixelSize,
    ): ICanvasScale {
        canvas.width = pixelSize.pixelWidth;
        canvas.height = pixelSize.pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.style.display = 'block';
        canvas.style.margin = '0';

        return {
            scaleX: pixelSize.pixelWidth / cssWidth,
            scaleY: pixelSize.pixelHeight / cssHeight,
        };
    }

    function isValidCanvasScale(scale: ICanvasScale) {
        return Number.isFinite(scale.scaleX)
            && Number.isFinite(scale.scaleY)
            && scale.scaleX > 0
            && scale.scaleY > 0;
    }

    function createOutputTransform(scale: ICanvasScale) {
        return scale.scaleX !== 1 || scale.scaleY !== 1 ? [
            scale.scaleX,
            0,
            0,
            scale.scaleY,
            0,
            0,
        ] : undefined;
    }

    async function createAnnotationRenderOptions(
        pdfPage: PDFPageProxy,
        options?: IRenderCanvasOptions,
    ) {
        const annotationCanvasMap = new Map<string, HTMLCanvasElement>();
        const annotationMode = AnnotationMode?.ENABLE_FORMS ?? AnnotationMode?.ENABLE ?? 1;
        const operationsFilter = await createHiddenAnnotationOperationsFilter(
            pdfPage,
            annotationMode,
            options?.hiddenAnnotationIds,
        );

        return {
            annotationCanvasMap,
            annotationMode,
            operationsFilter,
        };
    }

    async function prepareCanvasRender(
        pdfPage: PDFPageProxy,
        scale: number,
        options?: IRenderCanvasOptions,
    ): Promise<IPreparedCanvasRender | null> {
        const viewport = pdfPage.getViewport({ scale });
        const userUnit = viewport.userUnit ?? 1;
        const totalScaleFactor = scale * userUnit;
        const rawDims = viewport.rawDims as {
            pageWidth: number;
            pageHeight: number;
        };

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) {
            return null;
        }

        const cssWidth = viewport.width;
        const cssHeight = viewport.height;
        if (!isValidViewportSize(cssWidth, cssHeight)) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipping page ${pdfPage.pageNumber} render due to invalid viewport size ${cssWidth}x${cssHeight}`,
            );
            return null;
        }

        const pixelSize = calculateCanvasPixelSize(cssWidth, cssHeight, options);
        const canvasScale = setupCanvas(canvas, cssWidth, cssHeight, pixelSize);
        if (!isValidCanvasScale(canvasScale)) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipping page ${pdfPage.pageNumber} render due to invalid canvas scale ${canvasScale.scaleX}x${canvasScale.scaleY}`,
            );
            return null;
        }

        const annotationOptions = await createAnnotationRenderOptions(pdfPage, options);

        const renderContext = {
            canvasContext: context,
            canvas,
            transform: createOutputTransform(canvasScale),
            viewport,
            // Let PDF.js prepare separate annotation canvases for appearance-backed
            // annotations (for example placed image stamps) while keeping the
            // annotation layer responsible for attaching them into the DOM.
            ...annotationOptions,
        };

        return {
            canvas,
            viewport,
            annotationCanvasMap: annotationOptions.annotationCanvasMap,
            scaleX: canvasScale.scaleX,
            scaleY: canvasScale.scaleY,
            rawDims,
            userUnit,
            totalScaleFactor,
            startRender: () => (pdfPage.render(renderContext)),
        };
    }

    async function renderCanvas(
        pdfPage: PDFPageProxy,
        scale: number,
        options?: IRenderCanvasOptions,
    ): Promise<ICanvasRenderResult | null> {
        const preparedRender = await prepareCanvasRender(pdfPage, scale, options);
        if (!preparedRender) {
            return null;
        }

        const {
            startRender,
            ...renderResult
        } = preparedRender;
        const renderTask = startRender();
        options?.onRenderTask?.(renderTask);
        await renderTask.promise;
        return renderResult;
    }

    function applyContainerDimensions(
        container: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        scale: number,
        userUnit: number,
        totalScaleFactor: number,
    ) {
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        container.style.setProperty('--scale-factor', String(scale));
        container.style.setProperty('--user-unit', String(userUnit));
        container.style.setProperty(
            '--total-scale-factor',
            String(totalScaleFactor),
        );
    }

    function mountCanvas(
        canvasHost: HTMLElement,
        canvas: HTMLCanvasElement,
        container: HTMLElement,
        renderedContainerClass: string,
    ) {
        canvasHost.innerHTML = '';
        canvasHost.appendChild(canvas);
        container.classList.add(renderedContainerClass);

        const skeleton = container.querySelector<HTMLElement>('.pdf-page-skeleton');
        if (skeleton) {
            skeleton.style.display = 'none';
        }
    }

    return {
        cleanupCanvas,
        prepareCanvasRender,
        renderCanvas,
        applyContainerDimensions,
        mountCanvas,
    };
};

export type TCanvasRenderResult = ICanvasRenderResult;
