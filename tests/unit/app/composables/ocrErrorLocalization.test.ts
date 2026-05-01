import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    OCR_ERROR_MESSAGE_KEYS,
    useOcrErrorLocalizer,
} from '@app/composables/ocrErrorLocalization';
import { EN_MESSAGE_SCHEMA } from '@i18n-app';
import { flattenObject } from 'es-toolkit/object';

const dictionary: Record<string, string> = {
    'errors.file.invalid': 'Invalid file',
    'errors.ocr.loadLanguages': 'Load languages failed',
    'errors.ocr.noValidPages': 'No valid pages',
    'errors.ocr.timeout': 'OCR timeout',
    'errors.ocr.start': 'OCR start failed',
    'errors.ocr.noPdfData': 'No PDF data',
    'errors.ocr.createSearchablePdf': 'Create searchable PDF failed',
    'errors.ocr.noText': 'No text available',
    'errors.ocr.exportDocx': 'DOCX export failed',
};

vi.mock('@app/composables/useTypedI18n', () => ({ useTypedI18n: () => ({ t: (key: string) => dictionary[key] ?? key }) }));

describe('useOcrErrorLocalizer', () => {
    it('maps known invalid file errors to localized invalid file message', () => {
        const { localizeOcrError } = useOcrErrorLocalizer();

        const result = localizeOcrError(
            'Error invoking remote method \'file:read\': Invalid file path',
            'errors.ocr.createSearchablePdf',
        );

        expect(result).toBe('Invalid file');
    });

    it('prepends localized fallback for unknown errors', () => {
        const { localizeOcrError } = useOcrErrorLocalizer();

        const result = localizeOcrError('boom', 'errors.ocr.exportDocx');

        expect(result).toBe('DOCX export failed: boom');
    });
});

describe('OCR_ERROR_MESSAGE_KEYS', () => {
    const knownEnKeys = new Set(
        Object.entries(flattenObject(EN_MESSAGE_SCHEMA))
            .filter(entry => typeof entry[1] === 'string')
            .map(entry => entry[0]),
    );

    it('exposes a non-empty list of error message keys', () => {
        expect(OCR_ERROR_MESSAGE_KEYS.length).toBeGreaterThan(0);
    });

    it('contains only string entries', () => {
        for (const key of OCR_ERROR_MESSAGE_KEYS) {
            expect(typeof key).toBe('string');
            expect(key.length).toBeGreaterThan(0);
        }
    });

    it('has no duplicate entries', () => {
        const unique = new Set(OCR_ERROR_MESSAGE_KEYS);
        expect(unique.size).toBe(OCR_ERROR_MESSAGE_KEYS.length);
    });

    it('points only to keys present in the English message schema', () => {
        for (const key of OCR_ERROR_MESSAGE_KEYS) {
            expect(knownEnKeys.has(key)).toBe(true);
        }
    });

    it('contains the expected file and ocr error keys', () => {
        expect(Array.isArray(OCR_ERROR_MESSAGE_KEYS)).toBe(true);
        expect(OCR_ERROR_MESSAGE_KEYS).toContain('errors.file.invalid');
        expect(OCR_ERROR_MESSAGE_KEYS).toContain('errors.ocr.exportDocx');
    });
});
