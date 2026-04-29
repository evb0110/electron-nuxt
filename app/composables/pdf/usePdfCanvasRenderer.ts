import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode } from '@app/services/pdfjs/runtime-lib';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
import { BrowserLogger } from '@app/utils/browser-logger';
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

        const skippedIndices = new Set<number>();
        const annotationStack: boolean[] = [];
        // PDF.js encodes annotation appearance sections with begin/end annotation
        // operators in the shared operator list. These op ids are stable.
        const beginAnnotationOp = 80;
        const endAnnotationOp = 81;
        let hiddenDepth = 0;

        operatorList.fnArray.forEach((fn, index) => {
            if (fn === beginAnnotationOp) {
                const args: unknown = operatorList.argsArray[index];
                const annotationId = Array.isArray(args) && typeof args[0] === 'string'
                    ? normalizePdfJsAnnotationId(args[0])
                    : null;
                const isHidden = annotationId ? hiddenAnnotationIds.has(annotationId) : false;

                if (hiddenDepth > 0 || isHidden) {
                    skippedIndices.add(index);
                }

                annotationStack.push(isHidden);
                if (isHidden) {
                    hiddenDepth += 1;
                }
                return;
            }

            if (hiddenDepth > 0) {
                skippedIndices.add(index);
            }

            if (fn === endAnnotationOp) {
                const didHideCurrentAnnotation = annotationStack.pop() ?? false;
                if (didHideCurrentAnnotation) {
                    hiddenDepth = Math.max(0, hiddenDepth - 1);
                }
            }
        });

        return skippedIndices;
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
        if (
            !Number.isFinite(cssWidth) ||
      !Number.isFinite(cssHeight) ||
      cssWidth <= 0 ||
      cssHeight <= 0
        ) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipping page ${pdfPage.pageNumber} render due to invalid viewport size ${cssWidth}x${cssHeight}`,
            );
            return null;
        }
        const requestedPixelWidth = Math.max(1, Math.round(cssWidth * outputScale));
        const requestedPixelHeight = Math.max(1, Math.round(cssHeight * outputScale));
        const requestedPixelCount = requestedPixelWidth * requestedPixelHeight;
        const maxCanvasPixels = typeof options?.maxCanvasPixels === 'number'
            && Number.isFinite(options.maxCanvasPixels)
            && options.maxCanvasPixels > 0
            ? Math.max(1, Math.round(options.maxCanvasPixels))
            : null;
        const shouldClampPixels = maxCanvasPixels !== null && requestedPixelCount > maxCanvasPixels;
        const pixelScaleFactor = shouldClampPixels
            ? Math.sqrt(maxCanvasPixels / requestedPixelCount)
            : 1;
        const pixelWidth = Math.max(1, Math.round(requestedPixelWidth * pixelScaleFactor));
        const pixelHeight = Math.max(1, Math.round(requestedPixelHeight * pixelScaleFactor));

        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.style.display = 'block';
        canvas.style.margin = '0';

        const sx = pixelWidth / cssWidth;
        const sy = pixelHeight / cssHeight;
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Skipping page ${pdfPage.pageNumber} render due to invalid canvas scale ${sx}x${sy}`,
            );
            return null;
        }

        const transform = sx !== 1 || sy !== 1 ? [
            sx,
            0,
            0,
            sy,
            0,
            0,
        ] : undefined;
        const annotationCanvasMap = new Map<string, HTMLCanvasElement>();
        const annotationMode = AnnotationMode?.ENABLE_FORMS ?? AnnotationMode?.ENABLE ?? 1;
        const operationsFilter = await createHiddenAnnotationOperationsFilter(
            pdfPage,
            annotationMode,
            options?.hiddenAnnotationIds,
        );

        const renderContext = {
            canvasContext: context,
            canvas,
            transform,
            viewport,
            // Let PDF.js prepare separate annotation canvases for appearance-backed
            // annotations (for example placed image stamps) while keeping the
            // annotation layer responsible for attaching them into the DOM.
            annotationMode,
            annotationCanvasMap,
            operationsFilter,
        };

        return {
            canvas,
            viewport,
            annotationCanvasMap,
            scaleX: sx,
            scaleY: sy,
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
