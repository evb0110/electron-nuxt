import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import { PDFName } from 'pdf-lib';
import { parsePdfColor } from '@app/utils/pdf-viewer/serialization/pdf-serialization-colors/parsePdfColor';

export function setRgbColor(
    annotDict: PDFDict,
    doc: PDFDocument,
    key: 'C' | 'IC',
    color: string | undefined,
) {
    const rgb = parsePdfColor(color);
    if (!rgb) {
        annotDict.delete(PDFName.of(key));
        return;
    }

    annotDict.set(PDFName.of(key), doc.context.obj([
        rgb[0],
        rgb[1],
        rgb[2],
    ]));
}
