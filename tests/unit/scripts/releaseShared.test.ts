import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const {
    parsePinnedNodeMajor,
    restoreVersionIfChanged,
} = await import(
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

    it('restores the intended release version when verification drifts package metadata', () => {
        const writes: string[] = [];
        const messages: string[] = [];

        const restored = restoreVersionIfChanged('0.1.205', {
            readVersionFn: () => '0.1.204',
            stderr: { write: (message: string) => messages.push(message) },
            writeVersionFn: (version: string) => writes.push(version),
        });

        expect(restored).toBe(true);
        expect(writes).toEqual(['0.1.205']);
        expect(messages[0]).toContain('restoring 0.1.205 before committing');
    });

    it('leaves release metadata alone when verification preserves the bumped version', () => {
        const writes: string[] = [];

        const restored = restoreVersionIfChanged('0.1.205', {
            readVersionFn: () => '0.1.205',
            stderr: { write: () => undefined },
            writeVersionFn: (version: string) => writes.push(version),
        });

        expect(restored).toBe(false);
        expect(writes).toEqual([]);
    });
});
