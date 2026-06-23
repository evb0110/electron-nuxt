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

export const RTL_OCR_LANGUAGE_CODES = new Set(
    AVAILABLE_OCR_LANGUAGES
        .filter(language => language.script === 'rtl')
        .map(language => language.code),
);

export const GREEK_OCR_LANGUAGE_CODES = new Set(
    AVAILABLE_OCR_LANGUAGES
        .filter(language => language.script === 'greek')
        .map(language => language.code),
);

export function isRtlOcrLanguage(code: string) {
    return RTL_OCR_LANGUAGE_CODES.has(code);
}

export function isGreekOcrLanguage(code: string) {
    return GREEK_OCR_LANGUAGE_CODES.has(code);
}
