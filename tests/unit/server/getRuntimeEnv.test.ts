import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    firstNonEmptyStringPreservingWhitespace,
    firstNonWhitespaceString,
} from '@server/utils/getRuntimeEnv';

describe('root runtime environment selection', () => {
    it('returns an empty string when every value is undefined or empty', () => {
        expect(firstNonEmptyStringPreservingWhitespace([
            undefined,
            '',
        ])).toBe('');
    });

    it('preserves whitespace-only values', () => {
        expect(firstNonEmptyStringPreservingWhitespace([
            '   ',
            'fallback',
        ])).toBe('   ');
    });

    it('returns the first non-empty value in precedence order', () => {
        expect(firstNonEmptyStringPreservingWhitespace([
            undefined,
            '',
            'primary',
            'fallback',
        ])).toBe('primary');
    });

    it('skips whitespace-only values when selecting a configured value', () => {
        expect(firstNonWhitespaceString([
            '   ',
            ' fallback ',
        ])).toBe(' fallback ');
    });
});
