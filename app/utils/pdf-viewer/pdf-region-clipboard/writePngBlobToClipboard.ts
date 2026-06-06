export async function writePngBlobToClipboard(blob: Blob) {
    if (typeof ClipboardItem !== 'function') {
        throw new Error('ClipboardItem API is unavailable');
    }
    if (!globalThis.navigator?.clipboard || typeof globalThis.navigator.clipboard.write !== 'function') {
        throw new Error('Clipboard write API is unavailable');
    }

    const clipboardItem = new ClipboardItem({ 'image/png': blob });
    await globalThis.navigator.clipboard.write([clipboardItem]);
}
