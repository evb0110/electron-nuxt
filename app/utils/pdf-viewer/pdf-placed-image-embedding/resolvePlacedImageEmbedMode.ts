export function resolvePlacedImageEmbedMode(
    mimeType: string | null | undefined,
) {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    if (normalized === 'image/png') {
        return 'png';
    }
    if (normalized === 'image/jpeg') {
        return 'jpg';
    }
    return 'rasterize-png';
}
