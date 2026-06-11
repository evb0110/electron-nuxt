import {
    readdir,
    readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const ELECTRON_E2E_ROOT = join(process.cwd(), 'tests/e2e/electron');

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectTypeScriptFiles(path);
        }
        return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }));
    return files.flat();
}

describe('Electron E2E Vue internals policy', () => {
    it('does not probe Vue component internals from E2E tests or helpers', async () => {
        const files = await collectTypeScriptFiles(ELECTRON_E2E_ROOT);
        const offenders: string[] = [];

        for (const file of files) {
            const contents = await readFile(file, 'utf8');
            if (contents.includes('__vueParentComponent')) {
                offenders.push(file.replace(`${process.cwd()}/`, ''));
            }
        }

        expect(offenders).toEqual([]);
    });
});
