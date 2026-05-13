import en from '@i18n-app/messages/en';
import fr from '@i18n-app/messages/fr';
import pt from '@i18n-app/messages/pt';
import ru from '@i18n-app/messages/ru';
import {
    formatTranslationLeaf,
    getNestedTranslationLeaf,
} from '@i18n-core';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('message formatting', () => {
    it('uses explicit plural categories for Russian search result group counts', () => {
        const leaf = getNestedTranslationLeaf(ru, 'searchResults.pageWithCount');

        expect(leaf).not.toBeNull();
        expect(formatTranslationLeaf(leaf!, {
            page: 35,
            count: 1,
        }, 'ru')).toBe('Страница 35 (1 совпадение)');
        expect(formatTranslationLeaf(leaf!, {
            page: 36,
            count: 2,
        }, 'ru')).toBe('Страница 36 (2 совпадения)');
        expect(formatTranslationLeaf(leaf!, {
            page: 37,
            count: 4,
        }, 'ru')).toBe('Страница 37 (4 совпадения)');
        expect(formatTranslationLeaf(leaf!, {
            page: 38,
            count: 5,
        }, 'ru')).toBe('Страница 38 (5 совпадений)');
    });

    it('keeps English relative time singular and plural forms correct', () => {
        const leaf = getNestedTranslationLeaf(en, 'relativeTime.daysAgo');

        expect(leaf).not.toBeNull();
        expect(formatTranslationLeaf(leaf!, { count: 1 }, 'en')).toBe('1 day ago');
        expect(formatTranslationLeaf(leaf!, { count: 3 }, 'en')).toBe('3 days ago');
    });

    it('supports zero overrides for French count labels', () => {
        const leaf = getNestedTranslationLeaf(fr, 'annotations.noteCount');

        expect(leaf).not.toBeNull();
        expect(formatTranslationLeaf(leaf!, { count: 0 }, 'fr')).toBe('0 notes');
        expect(formatTranslationLeaf(leaf!, { count: 1 }, 'fr')).toBe('1 note');
    });

    it('supports zero overrides for Portuguese page nouns', () => {
        const leaf = getNestedTranslationLeaf(pt, 'pageNumbering.pageWord');

        expect(leaf).not.toBeNull();
        expect(formatTranslationLeaf(leaf!, { count: 0 }, 'pt')).toBe('páginas');
        expect(formatTranslationLeaf(leaf!, { count: 1 }, 'pt')).toBe('página');
        expect(formatTranslationLeaf(leaf!, { count: 3 }, 'pt')).toBe('páginas');
    });

    it('continues to support legacy pipe-delimited messages', () => {
        expect(formatTranslationLeaf('{count} note | {count} notes', { count: 2 }, 'en')).toBe('2 notes');
        expect(formatTranslationLeaf('{count} note | {count} notes', { count: 1 }, 'en')).toBe('1 note');
    });
});
