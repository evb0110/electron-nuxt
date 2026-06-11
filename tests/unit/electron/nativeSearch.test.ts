import {
    describe,
    expect,
    it,
} from 'vitest';
import { isNativeSearchSupportedOptions } from '@electron/search/nativeSearch';

describe('native search routing', () => {
    it('only routes literal searches whose matching semantics are preserved', () => {
        expect(isNativeSearchSupportedOptions({
            query: 'needle',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        })).toBe(true);
        expect(isNativeSearchSupportedOptions({
            query: 'ёж',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        })).toBe(true);
        expect(isNativeSearchSupportedOptions({
            query: 'İ',
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        })).toBe(true);
        expect(isNativeSearchSupportedOptions({
            query: 'needle',
            matchCase: false,
            wholeWord: true,
            useRegex: false,
        })).toBe(false);
        expect(isNativeSearchSupportedOptions({
            query: 'n.*dle',
            matchCase: false,
            wholeWord: false,
            useRegex: true,
        })).toBe(false);
    });
});
