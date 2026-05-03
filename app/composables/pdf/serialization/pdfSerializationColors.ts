import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import {
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import { parseHexColor } from '@app/utils/color';

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

export function parsePdfColor(color: string | undefined): [number, number, number] | null {
    if (!color || color === 'transparent' || color === 'none') {
        return null;
    }

    const trimmed = color.trim();
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/iu.test(trimmed)) {
        return parseHexColor(trimmed);
    }

    const rgbMatch = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/iu);
    if (!rgbMatch) {
        return null;
    }

    const values = rgbMatch.slice(1, 4).map(value => Math.max(0, Math.min(255, Number(value))) / 255);
    if (values.some(value => !Number.isFinite(value))) {
        return null;
    }
    return [
        values[0]!,
        values[1]!,
        values[2]!,
    ];
}

export function setOpacity(annotDict: PDFDict, opacity: number) {
    annotDict.set(PDFName.of('CA'), PDFNumber.of(opacity));
}

export function setBorderWidth(annotDict: PDFDict, doc: PDFDocument, strokeWidth: number) {
    annotDict.set(PDFName.of('Border'), doc.context.obj([
        0,
        0,
        strokeWidth,
    ]));
}
