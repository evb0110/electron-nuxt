import {
    mkdir,
    mkdtemp,
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

interface IWebDeploySourceStats {
    byteLength: number;
    fileCount: number;
    symlinkPaths: string[];
}

interface IWebDeploySourceModule {
    REQUIRED_VERCELIGNORE_ENTRIES: string[];
    collectWebDeploySourceStats: (options?: { projectRoot?: string }) => Promise<IWebDeploySourceStats>;
    validateVercelIgnoreEntries: (content: string, requiredEntries?: string[]) => unknown;
    validateWebDeploySource: (options?: {
        maxBytes?: number;
        maxFiles?: number;
        projectRoot?: string;
    }) => Promise<IWebDeploySourceStats>;
}

const {
    REQUIRED_VERCELIGNORE_ENTRIES,
    collectWebDeploySourceStats,
    validateVercelIgnoreEntries,
    validateWebDeploySource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-web-deploy-source.mjs')).href
) as IWebDeploySourceModule;

async function createTempProject() {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-web-source-'));

    await writeFile(
        path.join(tempRoot, '.vercelignore'),
        `${REQUIRED_VERCELIGNORE_ENTRIES.join('\n')}\n`,
        'utf8',
    );
    await mkdir(path.join(tempRoot, 'app'), {recursive: true});
    await writeFile(path.join(tempRoot, 'app', 'index.ts'), 'export const app = true;\n', 'utf8');

    return tempRoot;
}

describe('web deploy source policy', () => {
    it('requires local artifact exclusions in .vercelignore', () => {
        expect(() => validateVercelIgnoreEntries('native/\nresources/\n', [
            'native/',
            'resources/',
            'coverage/',
        ])).toThrow('.vercelignore is missing web deploy exclusions: coverage/');
    });

    it('does not count excluded local artifacts in the deploy source budget', async () => {
        const tempRoot = await createTempProject();
        try {
            await mkdir(path.join(tempRoot, 'native', 'pdf-image-combine', 'target'), {recursive: true});
            await mkdir(path.join(tempRoot, 'resources'), {recursive: true});
            await writeFile(
                path.join(tempRoot, 'native', 'pdf-image-combine', 'target', 'debug.bin'),
                Buffer.alloc(1024 * 1024),
            );
            await writeFile(path.join(tempRoot, 'resources', 'large.fixture'), Buffer.alloc(1024 * 1024));
            await writeFile(path.join(tempRoot, 'electron-builder.yml'), 'appId: test\n', 'utf8');

            const stats = await collectWebDeploySourceStats({projectRoot: tempRoot});

            expect(stats.fileCount).toBe(2);
            expect(stats.byteLength).toBeLessThan(16 * 1024);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails before Vercel upload when the deploy source exceeds the file cap', async () => {
        const tempRoot = await createTempProject();
        try {
            await expect(validateWebDeploySource({
                maxFiles: 1,
                projectRoot: tempRoot,
            })).rejects.toThrow('Web deploy source has too many files: 2 > 1');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
