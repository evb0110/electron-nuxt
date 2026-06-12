import type { ICancelableRenderTask } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter';

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

export const usePdfCanvasRenderer = (deps: {
    outputScale: number;
    defaultMaxCanvasPixels?: number | undefined;
}) => {
    const {
        outputScale,
        defaultMaxCanvasPixels,
    } = deps;

    function cleanupCanvas(canvas: HTMLCanvasElement) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
    }

    function cleanupCanvasRenderResult(renderResult: Pick<ICanvasRenderResult, 'canvas' | 'annotationCanvasMap'>) {
        cleanupCanvas(renderResult.canvas);
        renderResult.annotationCanvasMap.forEach((annotationCanvas) => {
            if (annotationCanvas !== renderResult.canvas) {
                cleanupCanvas(annotationCanvas);
            }
        });
        renderResult.annotationCanvasMap.clear();
    }

    function isValidViewportSize(width: number, height: number) {
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    }

    function normalizeMaxCanvasPixels(value: number | undefined) {
        return typeof value === 'number'
            && Number.isFinite(value)
            && value > 0
            ? Math.max(1, Math.round(value))
            : null;
    }

    function getMaxCanvasPixels(options?: IRenderCanvasOptions) {
        return normalizeMaxCanvasPixels(options?.maxCanvasPixels)
            ?? normalizeMaxCanvasPixels(defaultMaxCanvasPixels);
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
        try {
            await renderTask.promise;
            return renderResult;
        } catch (error) {
            cleanupCanvasRenderResult(renderResult);
            throw error;
        }
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
        previousCanvas?: HTMLCanvasElement | null,
    ) {
        if (previousCanvas?.parentElement === canvasHost) {
            previousCanvas.replaceWith(canvas);
        } else {
            canvasHost.prepend(canvas);
        }
    }

    return {
        cleanupCanvas,
        cleanupCanvasRenderResult,
        prepareCanvasRender,
        renderCanvas,
        applyContainerDimensions,
        mountCanvas,
    };
};
