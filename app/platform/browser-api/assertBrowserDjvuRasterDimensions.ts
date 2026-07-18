const BROWSER_DJVU_MAX_FULL_RESOLUTION_DECODE_PIXELS = 45_000_000;
const BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE = 32_768;

export function assertBrowserDjvuRasterDimensions(
    width: number,
    height: number,
    context = 'DjVu page',
) {
    if (
        !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height)
        || width <= 0
        || height <= 0
        || width > BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE
        || height > BROWSER_DJVU_MAX_FULL_RESOLUTION_EDGE
        || width > BROWSER_DJVU_MAX_FULL_RESOLUTION_DECODE_PIXELS / height
    ) {
        throw new RangeError(`${context} exceeds the browser full-resolution raster budget`);
    }
}
