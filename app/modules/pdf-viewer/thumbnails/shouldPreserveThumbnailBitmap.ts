export function shouldPreserveThumbnailBitmap(
    canvas: Pick<HTMLCanvasElement, 'dataset' | 'height' | 'width'>,
    minimumPixelWidth = 1,
) {
    // A preserved canvas still owns visible pixels while its replacement renders
    // offscreen, so it is just as reusable as the last committed canvas.
    const presentsBitmap = canvas.dataset.thumbnailRendered === 'true'
        || canvas.dataset.thumbnailPreservedBitmap === 'true';
    return presentsBitmap
        && canvas.width >= Math.max(1, Math.ceil(minimumPixelWidth))
        && canvas.height > 0;
}
