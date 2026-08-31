import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    describe,
    expect,
    it,
} from 'vitest';

interface IAssertPackagedAppContentsModule {
    EXPECTED_UNPACKED_DIST_ELECTRON: string[];
    REQUIRED_ASAR_ENTRIES: string[];
    REQUIRED_ASAR_PREFIXES: string[];
    collectEntryViolations: (entries: string[]) => string[];
    collectUnpackedViolations: (asarPath: string) => string[];
    normalizeAsarEntries: (entries: string[]) => string[];
}

async function loadPackagedContentsModule(): Promise<IAssertPackagedAppContentsModule> {
    return import(pathToFileURL(resolve(process.cwd(), 'scripts/release/assert-packaged-app-contents.mjs')).href);
}

describe('assert-packaged-app-contents', () => {
    it('normalizes Windows ASAR entries before required checks', async () => {
        const {
            REQUIRED_ASAR_ENTRIES,
            REQUIRED_ASAR_PREFIXES,
            collectEntryViolations,
            normalizeAsarEntries,
        } = await loadPackagedContentsModule();
        const windowsEntries = [
            ...REQUIRED_ASAR_ENTRIES,
            ...REQUIRED_ASAR_PREFIXES.map(prefix => `${prefix}fixture.js`),
        ].map(entry => entry.replaceAll('/', '\\'));

        expect(collectEntryViolations(normalizeAsarEntries(windowsEntries))).toEqual([]);
    });

    it('adds a leading slash to relative ASAR entries', async () => {
        const { normalizeAsarEntries } = await loadPackagedContentsModule();

        expect(normalizeAsarEntries([
            'package.json',
            'dist-electron\\main.js',
        ])).toEqual([
            '/package.json',
            '/dist-electron/main.js',
        ]);
    });

    it('requires a split main chunk in ASAR', async () => {
        const {
            REQUIRED_ASAR_ENTRIES,
            collectEntryViolations,
        } = await loadPackagedContentsModule();

        expect(collectEntryViolations(REQUIRED_ASAR_ENTRIES)).toContain(
            'missing required entry prefix: /dist-electron/main-chunk-',
        );
    });

    it('rejects split main chunks from app.asar.unpacked', async () => {
        const {
            EXPECTED_UNPACKED_DIST_ELECTRON,
            collectUnpackedViolations,
        } = await loadPackagedContentsModule();
        const root = await mkdtemp(join(tmpdir(), 'evb-packaged-contents-'));
        const asarPath = join(root, 'app.asar');
        const unpackedDistElectron = join(`${asarPath}.unpacked`, 'dist-electron');
        try {
            await mkdir(unpackedDistElectron, {recursive: true});
            await Promise.all(EXPECTED_UNPACKED_DIST_ELECTRON.map(file => writeFile(
                join(unpackedDistElectron, file),
                file === 'package.json' ? '{"type":"module"}' : '',
            )));
            await writeFile(
                join(unpackedDistElectron, 'main-chunk-fixture.js'),
                '',
            );

            expect(collectUnpackedViolations(asarPath)).toContain(
                'unexpected unpacked file: dist-electron/main-chunk-fixture.js',
            );
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects source maps and bundle metafiles', async () => {
        const { collectEntryViolations } = await loadPackagedContentsModule();

        expect(collectEntryViolations([
            '/dist-electron/main.js.map',
            '/dist-electron/preload.meta.json',
        ])).toEqual(expect.arrayContaining([
            'source map should not ship: /dist-electron/main.js.map',
            'bundle metafile should not ship: /dist-electron/preload.meta.json',
        ]));
    });

    it('rejects vendor packages and archives while allowing copied PDF assets', async () => {
        const { collectEntryViolations } = await loadPackagedContentsModule();
        const problems = collectEntryViolations([
            '/vendor/pdfjs-dist/pdfjs-dist-5.7.304-f029c046.tgz',
            '/vendor/pdfjs-dist/package/build/pdf.mjs',
            '/dist-electron/pdfjs-dist-codex-preview/build/pdf.mjs',
            '/dist-electron/pdf.d.ts',
            '/dist-electron/pdf.d.mts',
            '/dist-electron/pdf.worker.mjs.map',
            '/dist-electron/pdf_viewer.mjs.map',
            '/dist-electron/pdfjs.patch',
            '/dist-electron/pdf.sandbox.mjs',
            '/dist-electron/pdf.min.mjs',
            '/dist-electron/image_decoders/jpx.js',
            '/dist-electron/pdf.worker.mjs',
            '/nuxt-output/public/pdf/cmaps/78-H.bcmap',
        ]);
        expect(problems).toEqual(expect.arrayContaining([
            'forbidden entry present: /vendor/pdfjs-dist/pdfjs-dist-5.7.304-f029c046.tgz',
            'forbidden entry present: /vendor/pdfjs-dist/package/build/pdf.mjs',
            'complete or alternate PDF.js package content should not ship: /dist-electron/pdfjs-dist-codex-preview/build/pdf.mjs',
            'PDF.js declaration should not ship: /dist-electron/pdf.d.ts',
            'PDF.js declaration should not ship: /dist-electron/pdf.d.mts',
            'source map should not ship: /dist-electron/pdf.worker.mjs.map',
            'source map should not ship: /dist-electron/pdf_viewer.mjs.map',
            'PDF.js development artifact should not ship: /dist-electron/pdfjs.patch',
            'complete or alternate PDF.js package content should not ship: /dist-electron/pdf.sandbox.mjs',
            'complete or alternate PDF.js package content should not ship: /dist-electron/pdf.min.mjs',
            'complete or alternate PDF.js package content should not ship: /dist-electron/image_decoders/jpx.js',
        ]));
        expect(problems).not.toContain('complete or alternate PDF.js package content should not ship: /nuxt-output/public/pdf/cmaps/78-H.bcmap');
    });
});
