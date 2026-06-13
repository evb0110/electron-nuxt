import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    describe,
    expect,
    it,
} from 'vitest';

interface IAssertPackagedAppContentsModule {
    REQUIRED_ASAR_ENTRIES: string[];
    collectEntryViolations: (entries: string[]) => string[];
    normalizeAsarEntries: (entries: string[]) => string[];
}

async function loadPackagedContentsModule(): Promise<IAssertPackagedAppContentsModule> {
    return import(pathToFileURL(resolve(process.cwd(), 'scripts/release/assert-packaged-app-contents.mjs')).href);
}

describe('assert-packaged-app-contents', () => {
    it('normalizes Windows ASAR entries before required checks', async () => {
        const {
            REQUIRED_ASAR_ENTRIES,
            collectEntryViolations,
            normalizeAsarEntries,
        } = await loadPackagedContentsModule();
        const windowsEntries = REQUIRED_ASAR_ENTRIES.map((entry) => entry.replaceAll('/', '\\'));

        expect(collectEntryViolations(normalizeAsarEntries(windowsEntries))).toEqual([]);
    });

    it('adds a leading slash to relative ASAR entries', async () => {
        const { normalizeAsarEntries } = await loadPackagedContentsModule();

        expect(normalizeAsarEntries([
            'package.json',
            'dist-electron\\main.cjs',
        ])).toEqual([
            '/package.json',
            '/dist-electron/main.cjs',
        ]);
    });
});
