import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface IAsarUnpackModule {
    assertAsarUnpackMatchesWorkerBundles: (source: string) => void;
    getExpectedAsarUnpackEntries: () => string[];
}

const {
    assertAsarUnpackMatchesWorkerBundles,
    getExpectedAsarUnpackEntries,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-electron-builder-asar-unpack.mjs')).href
) as IAsarUnpackModule;

function formatConfig(entries: readonly string[]) {
    return [
        'asar: true',
        'asarUnpack:',
        ...entries.map(entry => `  - ${entry}`),
        'npmRebuild: false',
    ].join('\n');
}

describe('electron-builder asarUnpack check', () => {
    it('accepts the checked-in electron-builder.yml config', async () => {
        const source = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8');

        expect(() => {
            assertAsarUnpackMatchesWorkerBundles(source);
        }).not.toThrow();
    });

    it('ships the MCP stdio proxy script in packaged builds', async () => {
        const source = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8');

        expect(source).toContain('scripts/evb-mcp-proxy.mjs');
    });

    it('declares every shipped UI locale in Microsoft Store packages', async () => {
        const source = await readFile(resolve(process.cwd(), 'electron-builder.yml'), 'utf8');
        const storeLanguages = [
            'en-US',
            'ru-RU',
            'fr-FR',
            'de-DE',
            'es-ES',
            'it-IT',
            'pt-PT',
            'pt-BR',
            'nl-NL',
        ];

        for (const language of storeLanguages) {
            expect(source).toContain(`    - ${language}`);
        }
    });

    it('accepts the generated worker bundle unpack list', () => {
        expect(() => {
            assertAsarUnpackMatchesWorkerBundles(formatConfig(getExpectedAsarUnpackEntries()));
        }).not.toThrow();
    });

    it('rejects a missing unpacked worker bundle', () => {
        const entries = getExpectedAsarUnpackEntries().filter(entry => entry !== 'dist-electron/search-worker.js');

        expect(() => {
            assertAsarUnpackMatchesWorkerBundles(formatConfig(entries));
        }).toThrow('dist-electron/search-worker.js');
    });
});
