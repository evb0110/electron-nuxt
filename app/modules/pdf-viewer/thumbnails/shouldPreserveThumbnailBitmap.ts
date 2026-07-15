export function shouldPreserveThumbnailBitmap(
    canvas: Pick<HTMLCanvasElement, 'dataset' | 'height' | 'width'>,
) {
    return canvas.dataset.thumbnailRendered === 'true'
        && canvas.width > 0
        && canvas.height > 0;
}
