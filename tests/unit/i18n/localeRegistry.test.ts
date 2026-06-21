import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_LOCALE,
    LOCALE_CODES,
} from '@i18n-core';
import { LOCALE_DEFINITIONS } from '@i18n-core/localeDefinitions';
import { LOCALE_MESSAGES } from '@i18n-app/locales';

describe('locale registry', () => {
    it('keeps locale codes, definitions, and app messages synchronized', () => {
        const codes = [...LOCALE_CODES];
        const definitionCodes = LOCALE_DEFINITIONS.map(definition => definition.code);
        const messageCodes = Object.keys(LOCALE_MESSAGES);

        expect(new Set(codes).size).toBe(codes.length);
        expect(definitionCodes).toEqual(codes);
        expect(messageCodes).toEqual(codes);
        expect(codes).toContain(DEFAULT_LOCALE);
        expect(DEFAULT_LOCALE in LOCALE_MESSAGES).toBe(true);

        for (const definition of LOCALE_DEFINITIONS) {
            expect(definition.language).toBe(definition.code);
            expect(definition.file.endsWith('.ts')).toBe(true);
        }
    });
});
