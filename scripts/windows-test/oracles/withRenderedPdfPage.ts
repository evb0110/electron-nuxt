import {createCanvas} from '@napi-rs/canvas';
import type {
    Canvas,
    SKRSContext2D,
} from '@napi-rs/canvas';

interface IRenderedPdfPage {
    canvas: Canvas;
    context: SKRSContext2D;
    width: number;
    height: number;
}

function castRenderSurface<T>(value: object) {
    return value as T;
}

export async function withRenderedPdfPage<T>(
    page: unknown,
    scale: number,
    callback: (renderedPage: IRenderedPdfPage) => T | Promise<T>,
): Promise<T> {
    const pageProxy = page as {
        getViewport(options: {scale: number}): {
            width: number;
            height: number
        };
        render(options: {
            canvas: HTMLCanvasElement;
            canvasContext: CanvasRenderingContext2D;
            viewport: {
                width: number;
                height: number
            };
        }): {promise: Promise<void>};
    };
    const viewport = pageProxy.getViewport({scale});
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    await pageProxy.render({
        canvas: castRenderSurface<HTMLCanvasElement>(canvas),
        canvasContext: castRenderSurface<CanvasRenderingContext2D>(context),
        viewport,
    }).promise;
    return callback({
        canvas,
        context,
        width,
        height,
    });
}
