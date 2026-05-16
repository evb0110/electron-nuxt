import {
    describe,
    expect,
    it,
} from 'vitest';
import { OCR_ERROR_MESSAGE_KEYS } from '@app/composables/ocrErrorLocalization';
import { EN_MESSAGE_SCHEMA } from '@i18n-app';
import { flattenObject } from 'es-toolkit/object';

describe('OCR_ERROR_MESSAGE_KEYS', () => {
    const knownEnKeys = new Set(
        Object.entries(flattenObject(EN_MESSAGE_SCHEMA))
            .filter(entry => typeof entry[1] === 'string')
            .map(entry => entry[0]),
    );

    it('has no duplicate entries', () => {
        const unique = new Set(OCR_ERROR_MESSAGE_KEYS);
        expect(unique.size).toBe(OCR_ERROR_MESSAGE_KEYS.length);
    });

    it('points to keys present in the English message schema', () => {
        expect(OCR_ERROR_MESSAGE_KEYS.length).toBeGreaterThan(0);

        for (const key of OCR_ERROR_MESSAGE_KEYS) {
            expect(knownEnKeys.has(key)).toBe(true);
        }
    });
});
