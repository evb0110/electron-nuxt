import {
    describe,
    expect,
    it,
} from 'vitest';
import { LOCALE_CODES } from '@i18n-core';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';
import type { IOcrLanguage } from '@contracts/shared';
import {
    OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES,
    buildOcrLanguagePickerItems,
    findFailedOcrLanguageCodes,
    resolveOcrLanguageDisplayName,
    shouldShowOcrLanguageSearch,
    shouldShowOcrMultiLanguageHint,
} from '@app/modules/ocr-panel/runtime/useOcrPopupPresenter';

describe('OCR language display names', () => {
    it('resolves every registry code in every UI locale', () => {
        for (const locale of LOCALE_CODES) {
            for (const language of AVAILABLE_OCR_LANGUAGES) {
                const name = resolveOcrLanguageDisplayName(language.code, locale);

                expect(name.trim()).not.toBe('');
                expect(name.toLocaleLowerCase(locale)).not.toBe(
                    language.code.toLocaleLowerCase(locale),
                );
            }
        }
    });

    it('falls back to one English map and finally the raw code', () => {
        for (const language of AVAILABLE_OCR_LANGUAGES) {
            expect(resolveOcrLanguageDisplayName(language.code, 'en', null)).toBe(
                OCR_LANGUAGE_ENGLISH_FALLBACK_NAMES[language.code],
            );
        }
        expect(resolveOcrLanguageDisplayName('qaa', 'en', null)).toBe('qaa');
    });
});

describe('OCR language picker ordering and filtering', () => {
    const languages = [
        {
            code: 'spa',
            script: 'latin',
            modelState: 'missing',
        },
        {
            code: 'eng',
            script: 'latin',
            modelState: 'installed',
        },
        {
            code: 'fra',
            script: 'latin',
            modelState: 'installed',
        },
        {
            code: 'rus',
            script: 'cyrillic',
            modelState: 'missing',
        },
        {
            code: 'deu',
            script: 'latin',
            modelState: 'downloading',
        },
    ] satisfies IOcrLanguage[];

    it('orders selected, installed, and not-installed languages by localized name', () => {
        const items = buildOcrLanguagePickerItems(
            languages,
            [
                'rus',
                'spa',
            ],
            'en',
            '',
            new Set(),
        );

        expect(items.map(item => [
            item.value,
            item.group,
            item.startsGroup,
        ])).toEqual([
            [
                'rus',
                'selected',
                true,
            ],
            [
                'spa',
                'selected',
                false,
            ],
            [
                'eng',
                'installed',
                true,
            ],
            [
                'fra',
                'installed',
                false,
            ],
            [
                'deu',
                'missing',
                true,
            ],
        ]);
    });

    it('filters by localized name and Tesseract code', () => {
        expect(buildOcrLanguagePickerItems(
            languages,
            [],
            'es',
            'alemán',
            new Set(),
        ).map(item => item.value)).toEqual(['deu']);
        expect(buildOcrLanguagePickerItems(
            languages,
            [],
            'es',
            'spa',
            new Set(),
        ).map(item => item.value)).toEqual(['spa']);
    });

    it('marks a language named in a job error as failed', () => {
        const failedCodes = findFailedOcrLanguageCodes(
            languages,
            'Failed to download OCR language model "spa" after 3 attempts',
        );
        const items = buildOcrLanguagePickerItems(languages, [], 'en', '', failedCodes);

        expect(failedCodes).toEqual(new Set(['spa']));
        expect(items.find(item => item.value === 'spa')?.modelState).toBe('error');
    });

    it('shows scaling hints only beyond their thresholds', () => {
        expect(shouldShowOcrLanguageSearch(12)).toBe(false);
        expect(shouldShowOcrLanguageSearch(13)).toBe(true);
        expect(shouldShowOcrMultiLanguageHint(3)).toBe(false);
        expect(shouldShowOcrMultiLanguageHint(4)).toBe(true);
    });
});
