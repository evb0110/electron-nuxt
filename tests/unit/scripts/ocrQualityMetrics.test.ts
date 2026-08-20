import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    editDistance,
    measureOcrQuality,
    normalizeOcrText,
    retainsCriticalToken,
    tokenizeOcrWords,
} from '@scripts/ocrQualityMetrics.mjs';

describe('OCR quality metrics', () => {
    it('normalizes multilingual whitespace and dash variants without dropping identifiers', () => {
        expect(normalizeOcrText('  СЧЁТ\nQ7\u20112026  ')).toBe('счёт q7-2026');
        expect(tokenizeOcrWords('СЧЁТ Q7-2026 / 73.45')).toEqual([
            'счёт',
            'q7-2026',
            '73.45',
        ]);
    });

    it('calculates character and word edit rates over Unicode code points', () => {
        expect(editDistance(Array.from('счёт'), Array.from('счет'))).toBe(1);
        expect(measureOcrQuality('alpha beta', 'alpha zeta')).toMatchObject({
            cer: 0.1,
            wer: 0.5,
        });
    });

    it('requires exact normalized critical-token retention', () => {
        expect(retainsCriticalToken('Invoice INV\u20112048 total', 'inv-2048')).toBe(true);
        expect(retainsCriticalToken('Invoice INV-204B total', 'INV-2048')).toBe(false);
        expect(retainsCriticalToken('Archive box 190', '19')).toBe(false);
    });
});
