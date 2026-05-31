import type { IOcrLanguage } from '@contracts/shared';

export const AVAILABLE_OCR_LANGUAGES: IOcrLanguage[] = [
    {
        code: 'eng',
        script: 'latin',
    },
    {
        code: 'fra',
        script: 'latin',
    },
    {
        code: 'deu',
        script: 'latin',
    },
    {
        code: 'tur',
        script: 'latin',
    },
    {
        code: 'ell',
        script: 'greek',
    },
    {
        code: 'grc',
        script: 'greek',
    },
    {
        code: 'kmr',
        script: 'latin',
    },
    {
        code: 'rus',
        script: 'cyrillic',
    },
    {
        code: 'ara',
        script: 'rtl',
    },
    {
        code: 'heb',
        script: 'rtl',
    },
    {
        code: 'syr',
        script: 'rtl',
    },
];

export const AVAILABLE_OCR_LANGUAGE_CODES = new Set(
    AVAILABLE_OCR_LANGUAGES.map(language => language.code),
);
