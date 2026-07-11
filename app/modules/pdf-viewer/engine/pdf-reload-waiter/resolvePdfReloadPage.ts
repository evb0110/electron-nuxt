export function resolvePdfReloadPage(fallbackPage: number) {
    return Math.max(1, Math.floor(fallbackPage));
}
