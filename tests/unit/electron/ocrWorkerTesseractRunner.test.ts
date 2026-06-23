import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseTsvOcrData,
    parseTsvOutput,
    shouldNormalizeGreekMicroSign,
} from '@electron/ocr/worker/tesseractRunner';

describe('parseTsvOutput', () => {
    it('preserves line boxes positioned at the top of the page', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '4\t1\t1\t1\t1\t0\t10\t0\t40\t12\t-1\t',
            '5\t1\t1\t1\t1\t1\t10\t2\t40\t8\t95\tHeader',
        ].join('\n');

        expect(parseTsvOutput(tsv)).toEqual([{
            text: 'Header',
            x: 10,
            y: 0,
            width: 40,
            height: 12,
        }]);
    });

    it('accepts a valid header-only TSV as an empty OCR result', () => {
        const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

        expect(parseTsvOcrData(tsv)).toEqual({
            words: [],
            text: '',
        });
    });

    it('rejects prose output instead of treating it as empty TSV', () => {
        expect(() => parseTsvOcrData('Tesseract Open Source OCR Engine v5.5.0')).toThrow('Invalid Tesseract TSV output');
    });

    it('normalizes Greek micro signs for every registry Greek OCR language', () => {
        expect(shouldNormalizeGreekMicroSign(['ell'])).toBe(true);
        expect(shouldNormalizeGreekMicroSign(['grc'])).toBe(true);
        expect(shouldNormalizeGreekMicroSign(['eng'])).toBe(false);
    });
});
