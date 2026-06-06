import type {
    PDFDocument,
    PDFImage,
} from 'pdf-lib';

export function appendPdfImagePage(
    pdfDocument: PDFDocument,
    image: PDFImage,
) {
    const page = pdfDocument.addPage([
        image.width,
        image.height,
    ]);
    page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
    });
}
