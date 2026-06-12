export async function stripBrowserPdfEncryption(data: Uint8Array) {
    const { stripPdfEncryption } = await import('@app/utils/stripPdfEncryption');
    return stripPdfEncryption(data);
}
