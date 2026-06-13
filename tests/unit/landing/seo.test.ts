import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const {
    buildAbsoluteUrl,
    normalizeSiteUrl,
} = await import(pathToFileURL(resolve(process.cwd(), 'landing/shared/seo.ts')).href);

describe('landing seo helpers', () => {
    it('normalizes blank or malformed site URLs to the production fallback', () => {
        expect(normalizeSiteUrl('')).toBe('https://evb-viewer.vercel.app');
        expect(normalizeSiteUrl('   ')).toBe('https://evb-viewer.vercel.app');
        expect(normalizeSiteUrl('://broken')).toBe('https://evb-viewer.vercel.app');
    });

    it('adds a scheme and removes query/hash noise from configured origins', () => {
        expect(normalizeSiteUrl('example.test/path/?debug=1#frag')).toBe('https://example.test/path');
        expect(buildAbsoluteUrl('example.test/root', '/docs/')).toBe('https://example.test/docs');
    });
});
