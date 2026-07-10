import type { IOcrLanguage } from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';

const OCR_LANGUAGE_SCRIPTS = new Set<IOcrLanguage['script']>([
    'latin',
    'cyrillic',
    'greek',
    'rtl',
]);
const OCR_LANGUAGE_MAX_COUNT = 128;
const OCR_LANGUAGE_CODE_MAX_LENGTH = 32;

export function decodeOcrLanguages(value: unknown): IOcrLanguage[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > OCR_LANGUAGE_MAX_COUNT) {
        return null;
    }
    const languages: IOcrLanguage[] = [];
    const codes = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate)
            || typeof candidate.code !== 'string'
            || candidate.code.length > OCR_LANGUAGE_CODE_MAX_LENGTH
            || !/^[a-z][a-z0-9_]*$/u.test(candidate.code)
            || typeof candidate.script !== 'string'
            || !OCR_LANGUAGE_SCRIPTS.has(candidate.script as IOcrLanguage['script'])
            || codes.has(candidate.code)
        ) {
            return null;
        }
        codes.add(candidate.code);
        languages.push({
            code: candidate.code,
            script: candidate.script as IOcrLanguage['script'],
        });
    }
    return languages;
}

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
