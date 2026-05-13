import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildOcrTextLayerIndexText,
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';

describe('OCR text-layer text helpers', () => {
    const words = [
        {
            text: 'alpha',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        },
        {
            text: 'beta',
            x: 20,
            y: 0,
            width: 10,
            height: 10,
        },
        {
            text: 'gamma',
            x: 0,
            y: 18,
            width: 10,
            height: 10,
        },
    ];

    it('matches PDF.js OCR TextLayer item text including separators', () => {
        expect(buildOcrTextLayerItemText(words[0]!)).toBe('alpha ');
        expect(isLastOcrWordInLine(words, 0)).toBe(false);
        expect(isLastOcrWordInLine(words, 1)).toBe(true);
        expect(buildOcrTextLayerIndexText(words)).toBe('alpha beta \ngamma \n');
    });
});
