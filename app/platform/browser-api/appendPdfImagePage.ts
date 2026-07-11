import type {
    PDFDocument,
    PDFImage,
} from 'pdf-lib';
import {degrees} from 'pdf-lib';

export function appendPdfImagePage(
    pdfDocument: PDFDocument,
    image: PDFImage,
    options: {
        dpi?: number;
        orientation?: 1 | 3 | 6 | 8
    } = {},
) {
    const dpi = options.dpi && options.dpi > 0 ? options.dpi : 72;
    const width = (image.width / dpi) * 72;
    const height = (image.height / dpi) * 72;
    const orientation = options.orientation ?? 1;
    const swapsDimensions = orientation === 6 || orientation === 8;
    const page = pdfDocument.addPage([
        swapsDimensions ? height : width,
        swapsDimensions ? width : height,
    ]);
    if (orientation === 3) {
        page.drawImage(image, {
            x: width,
            y: height,
            width,
            height,
            rotate: degrees(180),
        });
    } else if (orientation === 6) {
        page.drawImage(image, {
            x: height,
            y: 0,
            width,
            height,
            rotate: degrees(90),
        });
    } else if (orientation === 8) {
        page.drawImage(image, {
            x: 0,
            y: width,
            width,
            height,
            rotate: degrees(-90),
        });
    } else {
        page.drawImage(image, {
            x: 0,
            y: 0,
            width,
            height,
        });
    }
}
