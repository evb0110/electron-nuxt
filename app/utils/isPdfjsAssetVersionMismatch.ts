const PDFJS_ASSET_VERSION_MISMATCH = /^PDF\.js vendored asset version mismatch at /u;

export function isPdfjsAssetVersionMismatch(message: string) {
    return PDFJS_ASSET_VERSION_MISMATCH.test(message.trim());
}
