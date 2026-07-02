import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface ICopyPdfjsAssetsModule {
    readPdfjsPackageVersion: (root?: string) => Promise<string>;
    writePdfjsVersionStamp: (options?: {
        root?: string;
        targetRoot?: string;
    }) => Promise<string>;
}

const {
    readPdfjsPackageVersion,
    writePdfjsVersionStamp,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/copy-pdfjs-assets.mjs')).href
) as ICopyPdfjsAssetsModule;

describe('copy-pdfjs-assets', () => {
    it('writes a pdf.js version stamp from the installed package metadata', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-pdfjs-assets-'));
        const pdfjsRoot = path.join(tempRoot, 'node_modules', 'pdfjs-dist');
        const targetRoot = path.join(tempRoot, 'public', 'pdf');
        try {
            await mkdir(pdfjsRoot, {recursive: true});
            await writeFile(
                path.join(pdfjsRoot, 'package.json'),
                JSON.stringify({version: '9.8.7'}),
            );

            await expect(writePdfjsVersionStamp({
                root: pdfjsRoot,
                targetRoot,
            })).resolves.toBe('9.8.7');

            await expect(readFile(path.join(targetRoot, '.pdfjs-version'), 'utf8'))
                .resolves
                .toBe('9.8.7\n');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps the committed public stamp aligned with pdfjs-dist', async () => {
        const installedVersion = await readPdfjsPackageVersion();
        const committedStamp = await readFile(
            path.join(process.cwd(), 'public', 'pdf', '.pdfjs-version'),
            'utf8',
        );

        expect(committedStamp.trim()).toBe(installedVersion);
    });
});
