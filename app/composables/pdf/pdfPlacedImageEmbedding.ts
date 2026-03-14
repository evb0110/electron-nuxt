export type TPlacedImageEmbedMode = 'png' | 'jpg' | 'rasterize-png';

export function resolvePlacedImageEmbedMode(
    mimeType: string | null | undefined,
): TPlacedImageEmbedMode {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    if (normalized === 'image/png') {
        return 'png';
    }
    if (normalized === 'image/jpeg') {
        return 'jpg';
    }
    return 'rasterize-png';
}
