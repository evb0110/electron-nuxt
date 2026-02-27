import { vi } from 'vitest';
import { flattenObject } from 'es-toolkit/object';
import enMessages from '@app/locales/en';

const EN_TRANSLATION_KEYS = new Set(
    Object.entries(flattenObject(enMessages))
        .filter(entry => typeof entry[1] === 'string')
        .map(entry => entry[0]),
);

const translate = (key: string) => {
    if (!EN_TRANSLATION_KEYS.has(key)) {
        throw new Error(`Unknown i18n key in test: "${key}"`);
    }
    return key;
};

const i18nComposer = {
    t: translate,
    setLocale: async () => {},
    loadLocaleMessages: async () => {},
};

vi.mock('vue-i18n', () => ({useI18n: () => i18nComposer}));
