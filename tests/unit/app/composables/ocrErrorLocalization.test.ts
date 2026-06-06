import {
    describe,
    expect,
    it,
} from 'vitest';
import { ocrErrorMessageKeys } from '@app/utils/ocr/ocrErrorMessageKeys';
import { EN_MESSAGE_SCHEMA } from '@i18n-app';
import { flattenObject } from 'es-toolkit/object';

describe('ocrErrorMessageKeys', () => {
    const knownEnKeys = new Set(
        Object.entries(flattenObject(EN_MESSAGE_SCHEMA))
            .filter(entry => typeof entry[1] === 'string')
            .map(entry => entry[0]),
    );

    it('has no duplicate entries', () => {
        const unique = new Set(ocrErrorMessageKeys);
        expect(unique.size).toBe(ocrErrorMessageKeys.length);
    });

    it('points to keys present in the English message schema', () => {
        expect(ocrErrorMessageKeys.length).toBeGreaterThan(0);

        for (const key of ocrErrorMessageKeys) {
            expect(knownEnKeys.has(key)).toBe(true);
        }
    });
});
