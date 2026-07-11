import type { IOcrLanguage } from '@contracts/shared';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

const OCR_LANGUAGE_SCRIPTS = [
    'latin',
    'cyrillic',
    'greek',
    'rtl',
] as const satisfies ReadonlyArray<IOcrLanguage['script']>;
const OCR_LANGUAGE_MAX_COUNT = 128;
const OCR_LANGUAGE_CODE_MAX_LENGTH = 32;
const OCR_LANGUAGE_MODEL_STATES = [
    'installed',
    'downloading',
    'missing',
] as const;

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
            || !isOneOf(OCR_LANGUAGE_SCRIPTS, candidate.script)
            || (candidate.modelState !== undefined && !isOneOf(OCR_LANGUAGE_MODEL_STATES, candidate.modelState))
            || codes.has(candidate.code)
        ) {
            return null;
        }
        codes.add(candidate.code);
        languages.push({
            code: candidate.code,
            script: candidate.script,
            ...(candidate.modelState === undefined ? {} : {modelState: candidate.modelState}),
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

/** SHA-256 digests for the exact tessdata_best commit used by runtime downloads. */
export const OCR_LANGUAGE_MODEL_SHA256 = {
    ara: 'ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896',
    deu: '8407331d6aa0229dc927685c01a7938fc5a641d1a9524f74838cdac599f0d06e',
    ell: '288b4ea00bab450cf39893d22f04a2835a8469b673b5b20dcb39b159d1bbc9b8',
    eng: '8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba',
    fra: '907743d98915c91a3906dfbf6e48b97598346698fe53aaa797e1a064ffcac913',
    grc: 'dfc9bda286cd9d8755b1832e5731a5425d1cf0803393a5fa6dee078466178cf1',
    heb: 'dbaa827aea6bc21215638447f17783a1004987c2d0bf5573d111fee397abdae5',
    kmr: '6017f6284e6771419f85a72218a2e84c5c6c19a4ed0ef27286cd637981293b76',
    rus: 'b617eb6830ffabaaa795dd87ea7fd251adfe9cf0efe05eb9a2e8128b7728d6b6',
    syr: '7642168b7731866d0ec4c74c67780913db4a04583874fcff0078daa8430bd887',
    tur: 'e0c3338dc17503dc7d335a507c9ae01b2b46cfd07561171e1e1ac55d85e8e438',
} as const satisfies Record<(typeof AVAILABLE_OCR_LANGUAGES)[number]['code'], string>;

/** Models seeded into an offline installation; every other supported model is downloaded on demand. */
export const BUNDLED_OCR_LANGUAGE_CODES = [
    'eng',
    'rus',
] as const satisfies ReadonlyArray<(typeof AVAILABLE_OCR_LANGUAGES)[number]['code']>;

export const BUNDLED_OCR_LANGUAGE_CODE_SET = new Set<string>(BUNDLED_OCR_LANGUAGE_CODES);

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
