import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ICheckDevEnvironmentModule {
    isNode24: (version: string) => boolean;
    resolveHostTag: () => string | null;
    statusFromBoolean: (ok: boolean, missingStatus?: string) => string;
}

const {
    isNode24,
    resolveHostTag,
    statusFromBoolean,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-dev-environment.mjs')).href
) as ICheckDevEnvironmentModule;

describe('check-dev-environment helpers', () => {
    it('recognizes only Node 24 version strings', () => {
        expect(isNode24('v24.0.0')).toBe(true);
        expect(isNode24('v24.11.2')).toBe(true);
        expect(isNode24('v22.9.0')).toBe(false);
        expect(isNode24('v20.0.0')).toBe(false);
        expect(isNode24('24.0.0')).toBe(false);
    });

    it('maps ok state to a status token, falling back to the missing label', () => {
        expect(statusFromBoolean(true)).toBe('ok');
        expect(statusFromBoolean(false)).toBe('missing');
        expect(statusFromBoolean(false, 'fail')).toBe('fail');
    });

    it('resolves a supported host tag or null', () => {
        const tag = resolveHostTag();
        if (tag !== null) {
            expect(tag).toMatch(/^(?:darwin|linux|win32)-(?:arm64|x64)$/u);
        }
    });
});
