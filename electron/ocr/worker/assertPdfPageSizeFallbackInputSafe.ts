import { stat } from 'fs/promises';

export async function assertPdfPageSizeFallbackInputSafe(pdfPath: string, maxInputBytes: number) {
    const pdfStat = await stat(pdfPath);
    if (!pdfStat.isFile()) {
        throw new Error(`OCR page-size fallback input is not a regular file: ${pdfPath}`);
    }
    if (pdfStat.size > maxInputBytes) {
        const maxMb = Math.floor(maxInputBytes / (1024 * 1024));
        throw new Error(`OCR page-size fallback skipped for PDF larger than ${maxMb}MB: ${pdfPath}`);
    }
}
