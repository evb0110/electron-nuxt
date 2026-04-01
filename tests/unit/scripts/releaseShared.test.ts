import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { parsePinnedNodeMajor } = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/shared.mjs')).href,
);

describe('release shared helpers', () => {
    it('parses the project node baseline from a pinned major range', () => {
        expect(parsePinnedNodeMajor('24.x')).toBe(24);
        expect(parsePinnedNodeMajor('26.x')).toBe(26);
    });

    it('rejects non-pinned node engine ranges', () => {
        expect(() => parsePinnedNodeMajor('lts/*')).toThrow(
            'requires package.json engines.node to use a pinned "<major>.x" range',
        );
        expect(() => parsePinnedNodeMajor('>=24')).toThrow(
            'requires package.json engines.node to use a pinned "<major>.x" range',
        );
    });
});
