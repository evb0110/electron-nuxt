import {
    partition,
    uniq,
} from 'es-toolkit/array';

const RTL_LANGUAGE_CODES = new Set([
    'heb',
    'syr',
]);

const LATIN_WORD_BOUNDARY_CONFIG: string[] = [
    '-c',
    'preserve_interword_spaces=1',
    '-c',
    'textord_words_default_minspace=0.3',
    '-c',
    'textord_words_min_minspace=0.2',
    '-c',
    'tosp_fuzzy_space_factor=0.5',
    '-c',
    'tosp_min_sane_kn_sp=1.2',
    '-c',
    'tosp_kern_gap_factor1=1.5',
    '-c',
    'tosp_kern_gap_factor2=1.0',
    '-c',
    'load_system_dawg=0',
    '-c',
    'load_freq_dawg=0',
];

const RTL_CONFIG: string[] = [];

interface ITesseractLanguageConfig {
    orderedLanguages: string[];
    extraConfigArgs: string[];
    hasRtl: boolean;
}

export function isRtlOcrLanguage(code: string): boolean {
    return RTL_LANGUAGE_CODES.has(code);
}

export function resolveTesseractLanguageConfig(languages: string[]): ITesseractLanguageConfig {
    const deduped = uniq(languages.filter(Boolean));
    const hasRtl = deduped.some(isRtlOcrLanguage);

    if (!hasRtl) {
        return {
            orderedLanguages: deduped,
            extraConfigArgs: [...LATIN_WORD_BOUNDARY_CONFIG],
            hasRtl: false,
        };
    }

    const [
        rtlLanguages,
        nonRtlLanguages,
    ] = partition(deduped, isRtlOcrLanguage);
    const rtlFirst = [
        ...rtlLanguages,
        ...nonRtlLanguages,
    ];

    return {
        orderedLanguages: rtlFirst,
        extraConfigArgs: [...RTL_CONFIG],
        hasRtl: true,
    };
}
