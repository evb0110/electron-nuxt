export function shouldPreserveThumbnailBitmap(
    canvas: Pick<HTMLCanvasElement, 'dataset' | 'height' | 'width'>,
    minimumPixelWidth = 1,
) {
    return canvas.dataset.thumbnailRendered === 'true'
        && canvas.width >= Math.max(1, Math.ceil(minimumPixelWidth))
        && canvas.height > 0;
}
