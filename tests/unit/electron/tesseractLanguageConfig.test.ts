import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AVAILABLE_OCR_LANGUAGES,
    GREEK_OCR_LANGUAGE_CODES,
    RTL_OCR_LANGUAGE_CODES,
    isGreekOcrLanguage,
    isRtlOcrLanguage,
} from '@contracts/ocrLanguages';
import { resolveTesseractLanguageConfig } from '@electron/ocr/resolveTesseractLanguageConfig';

describe('resolveTesseractLanguageConfig', () => {
    it('derives the rtl language set from the canonical OCR language registry', () => {
        const registryRtlCodes = AVAILABLE_OCR_LANGUAGES
            .filter(language => language.script === 'rtl')
            .map(language => language.code);

        expect(Array.from(RTL_OCR_LANGUAGE_CODES)).toEqual(registryRtlCodes);
        expect(registryRtlCodes.every(isRtlOcrLanguage)).toBe(true);

        const config = resolveTesseractLanguageConfig([
            'eng',
            ...registryRtlCodes,
            'fra',
        ]);

        expect(config.orderedLanguages.slice(0, registryRtlCodes.length)).toEqual(registryRtlCodes);
        expect(config.hasRtl).toBe(registryRtlCodes.length > 0);
    });

    it('derives the Greek language set from the canonical OCR language registry', () => {
        const registryGreekCodes = AVAILABLE_OCR_LANGUAGES
            .filter(language => language.script === 'greek')
            .map(language => language.code);

        expect(Array.from(GREEK_OCR_LANGUAGE_CODES)).toEqual(registryGreekCodes);
        expect(registryGreekCodes.every(isGreekOcrLanguage)).toBe(true);
    });

    it('keeps non-rtl language order and applies spacing config', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'fra',
            'deu',
        ]);

        expect(config.orderedLanguages).toEqual([
            'eng',
            'fra',
            'deu',
        ]);
        expect(config.hasRtl).toBe(false);
        expect(config.extraConfigArgs).toContain('preserve_interword_spaces=1');
        expect(config.extraConfigArgs).toContain('load_system_dawg=0');
    });

    it('keeps Latin spacing config while preserving dictionaries for accurate profiles', () => {
        const config = resolveTesseractLanguageConfig(['eng'], {preserveDictionaries: true});

        expect(config.orderedLanguages).toEqual(['eng']);
        expect(config.extraConfigArgs).toContain('preserve_interword_spaces=1');
        expect(config.extraConfigArgs).not.toContain('load_system_dawg=0');
        expect(config.extraConfigArgs).not.toContain('load_freq_dawg=0');
    });

    it('moves rtl languages before latin languages and skips latin config', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'heb',
            'fra',
            'syr',
        ]);

        expect(config.orderedLanguages).toEqual([
            'heb',
            'syr',
            'eng',
            'fra',
        ]);
        expect(config.hasRtl).toBe(true);
        expect(config.extraConfigArgs).toEqual([]);
    });

    it('uses empty config for rtl-only languages', () => {
        const config = resolveTesseractLanguageConfig(['heb']);

        expect(config.hasRtl).toBe(true);
        expect(config.extraConfigArgs).toEqual([]);
    });

    it('deduplicates languages while preserving relative order within groups', () => {
        const config = resolveTesseractLanguageConfig([
            'eng',
            'heb',
            'eng',
            'heb',
            'deu',
        ]);

        expect(config.orderedLanguages).toEqual([
            'heb',
            'eng',
            'deu',
        ]);
    });
});
