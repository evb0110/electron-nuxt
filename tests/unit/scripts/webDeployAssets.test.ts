import {
    copyFile,
    mkdir,
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IWebDeployAssetsModule {
    REQUIRED_WEB_WASM_ASSETS: Array<{ relativePath: string }>;
    getExpectedWebDeployOutputRoots: (env?: NodeJS.ProcessEnv) => string[];
    validateWebDeployAssets: (options?: {
        env?: NodeJS.ProcessEnv;
        outputRoots?: string[];
        projectRoot?: string;
        sourceRoot?: string;
    }) => Promise<unknown>;
}

const {
    REQUIRED_WEB_WASM_ASSETS,
    getExpectedWebDeployOutputRoots,
    validateWebDeployAssets,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-web-deploy-assets.mjs')).href
) as IWebDeployAssetsModule;

async function createTempProject() {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-web-assets-'));
    const roots = [
        'public',
        'nuxt-output/public',
        '.vercel/output/static',
    ];

    for (const root of roots) {
        await mkdir(path.join(tempRoot, root, 'wasm'), {recursive: true});
    }

    for (const asset of REQUIRED_WEB_WASM_ASSETS) {
        const sourcePath = path.join(process.cwd(), 'public', asset.relativePath);
        for (const root of roots) {
            await copyFile(sourcePath, path.join(tempRoot, root, asset.relativePath));
        }
    }

    return tempRoot;
}

describe('web deploy assets check', () => {
    it('checks local Nuxt build output assets', async () => {
        const tempRoot = await createTempProject();
        try {
            await expect(validateWebDeployAssets({
                env: {},
                projectRoot: tempRoot,
            })).resolves.toBeTruthy();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('checks Vercel Build Output static assets', async () => {
        const tempRoot = await createTempProject();
        try {
            await expect(validateWebDeployAssets({
                env: {VERCEL: '1'},
                projectRoot: tempRoot,
            })).resolves.toBeTruthy();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('uses the same output roots as nuxt.config.ts', () => {
        expect(getExpectedWebDeployOutputRoots({})).toEqual(['nuxt-output/public']);
        expect(getExpectedWebDeployOutputRoots({VERCEL: '1'})).toEqual(['.vercel/output/static']);
        expect(getExpectedWebDeployOutputRoots({NOW_BUILDER: '1'})).toEqual(['.vercel/output/static']);
    });

    it('fails when the expected build output is absent', async () => {
        const tempRoot = await createTempProject();
        try {
            await rm(path.join(tempRoot, 'nuxt-output'), {
                force: true,
                recursive: true,
            });
            await expect(validateWebDeployAssets({
                env: {},
                projectRoot: tempRoot,
            })).rejects.toThrow('Missing web build output nuxt-output/public');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
