import type { IAnnotationMarkerRect } from '@app/types/annotations';

interface ITraverseTextMarkupCanvasRectOptions {stride?: number | ((width: number, height: number) => number) | undefined;}

interface ITraverseTextMarkupCanvasRectPixel {
    data: ImageData;
    height: number;
    index: number;
    width: number;
    x: number;
    y: number;
}

function resolveCanvasRectImageData(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
) {
    const canvasRect = canvas.getBoundingClientRect();
    const pageRect = pageContainer.getBoundingClientRect();
    if (
        canvasRect.width <= 0
        || canvasRect.height <= 0
        || pageRect.width <= 0
        || pageRect.height <= 0
    ) {
        return null;
    }

    const viewportLeft = pageRect.left + targetRect.left * pageRect.width;
    const viewportTop = pageRect.top + targetRect.top * pageRect.height;
    const viewportWidth = targetRect.width * pageRect.width;
    const viewportHeight = targetRect.height * pageRect.height;
    const sampleLeft = Math.max(canvasRect.left, viewportLeft);
    const sampleTop = Math.max(canvasRect.top, viewportTop);
    const sampleRight = Math.min(canvasRect.right, viewportLeft + viewportWidth);
    const sampleBottom = Math.min(canvasRect.bottom, viewportTop + viewportHeight);
    if (sampleRight <= sampleLeft || sampleBottom <= sampleTop) {
        return null;
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return null;
    }

    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    const left = Math.max(0, Math.floor((sampleLeft - canvasRect.left) * scaleX));
    const top = Math.max(0, Math.floor((sampleTop - canvasRect.top) * scaleY));
    const right = Math.min(canvas.width, Math.ceil((sampleRight - canvasRect.left) * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil((sampleBottom - canvasRect.top) * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
        return null;
    }

    try {
        return {
            context,
            data: context.getImageData(left, top, width, height),
            height,
            left,
            top,
            width,
        };
    } catch {
        return null;
    }
}

export function traverseTextMarkupCanvasRect(
    canvas: HTMLCanvasElement,
    pageContainer: HTMLElement,
    targetRect: IAnnotationMarkerRect,
    visitor?: ((pixel: ITraverseTextMarkupCanvasRectPixel) => void) | undefined,
    options: ITraverseTextMarkupCanvasRectOptions = {},
) {
    const image = resolveCanvasRectImageData(canvas, pageContainer, targetRect);
    if (!image) {
        return null;
    }

    if (!visitor) {
        return image;
    }

    const strideValue = typeof options.stride === 'function'
        ? options.stride(image.width, image.height)
        : options.stride;
    const stride = Math.max(1, strideValue ?? 1);
    for (let y = 0; y < image.height; y += stride) {
        for (let x = 0; x < image.width; x += stride) {
            visitor({
                data: image.data,
                height: image.height,
                index: (y * image.width + x) * 4,
                width: image.width,
                x,
                y,
            });
        }
    }

    return image;
}
