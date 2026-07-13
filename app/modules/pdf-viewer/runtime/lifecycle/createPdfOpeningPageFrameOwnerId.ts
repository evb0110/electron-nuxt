let nextPdfOpeningPageFrameOwnerId = 0;

export function createPdfOpeningPageFrameOwnerId() {
    nextPdfOpeningPageFrameOwnerId += 1;
    return `pdfjs:${String(nextPdfOpeningPageFrameOwnerId)}`;
}
