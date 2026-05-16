import {
    formatTranslationLeaf,
    plural,
} from '@i18n-core';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('message formatting', () => {
    it('selects plural message categories and zero overrides', () => {
        const leaf = plural({
            zero: 'no files',
            one: '{count} file',
            few: '{count} files few',
            many: '{count} files many',
            other: '{count} files',
        });

        expect(formatTranslationLeaf(leaf, { count: 0 }, 'en')).toBe('no files');
        expect(formatTranslationLeaf(leaf, { count: 1 }, 'en')).toBe('1 file');
        expect(formatTranslationLeaf(leaf, { count: 2 }, 'ru')).toBe('2 files few');
        expect(formatTranslationLeaf(leaf, { count: 5 }, 'ru')).toBe('5 files many');
        expect(formatTranslationLeaf(leaf, { count: 3 }, 'en')).toBe('3 files');
    });

    it('continues to support legacy pipe-delimited messages', () => {
        expect(formatTranslationLeaf('{count} note | {count} notes', { count: 2 }, 'en')).toBe('2 notes');
        expect(formatTranslationLeaf('{count} note | {count} notes', { count: 1 }, 'en')).toBe('1 note');
    });
});
