import {
    copyFile,
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

interface IWebDeployAssetsModule {
    REQUIRED_WEB_DEPLOY_ASSETS: Array<{ relativePath: string }>;
    REQUIRED_WEB_OUTPUT_CONTRACTS: string[];
    REQUIRED_WEB_WASM_ASSETS: Array<{ relativePath: string }>;
    getExpectedWebDeployOutputRoots: (env?: NodeJS.ProcessEnv) => string[];
    validateWebDeployAssets: (options?: {
        env?: NodeJS.ProcessEnv;
        outputRoots?: string[];
        projectRoot?: string;
        sourceRoot?: string;
    }) => Promise<unknown>;
    validateVercelFunctionBoot: (options?: {projectRoot?: string}) => Promise<void>;
}

const {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
    REQUIRED_WEB_WASM_ASSETS,
    getExpectedWebDeployOutputRoots,
    validateWebDeployAssets,
    validateVercelFunctionBoot,
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

    const wasmPaths = new Set(REQUIRED_WEB_WASM_ASSETS.map(asset => asset.relativePath));
    for (const asset of REQUIRED_WEB_DEPLOY_ASSETS) {
        if (wasmPaths.has(asset.relativePath)) {
            continue;
        }
        for (const root of roots) {
            const assetPath = path.join(tempRoot, root, asset.relativePath);
            await mkdir(path.dirname(assetPath), {recursive: true});
            await writeFile(assetPath, 'required web asset', 'utf8');
        }
    }
    for (const root of roots.slice(1)) {
        for (const relativePath of REQUIRED_WEB_OUTPUT_CONTRACTS) {
            await writeFile(path.join(tempRoot, root, relativePath), '<!doctype html>', 'utf8');
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

    it('loads the generated Vercel server function entry', async () => {
        const tempRoot = await createTempProject();
        const functionRoot = path.join(tempRoot, '.vercel/output/functions/__fallback.func');
        try {
            await mkdir(functionRoot, {recursive: true});
            await writeFile(path.join(functionRoot, 'index.mjs'), 'export default {};\n', 'utf8');
            await expect(validateVercelFunctionBoot({projectRoot: tempRoot})).resolves.toBeUndefined();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails when a generated Vercel server dependency is missing', async () => {
        const tempRoot = await createTempProject();
        const functionRoot = path.join(tempRoot, '.vercel/output/functions/__fallback.func');
        try {
            await mkdir(functionRoot, {recursive: true});
            await writeFile(
                path.join(functionRoot, 'index.mjs'),
                'import "./missing-dependency.mjs";\nexport default {};\n',
                'utf8',
            );
            await expect(validateVercelFunctionBoot({projectRoot: tempRoot}))
                .rejects.toThrow('Vercel server function failed to load');
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
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

    it.each(REQUIRED_WEB_DEPLOY_ASSETS)(
        'fails when required output asset $relativePath is absent',
        async (asset) => {
            const tempRoot = await createTempProject();
            try {
                await rm(path.join(tempRoot, 'nuxt-output/public', asset.relativePath));
                await expect(validateWebDeployAssets({
                    env: {},
                    projectRoot: tempRoot,
                })).rejects.toThrow(`Missing web build output nuxt-output/public asset: ${asset.relativePath}`);
            } finally {
                await rm(tempRoot, {
                    force: true,
                    recursive: true,
                });
            }
        },
    );

    it.each(REQUIRED_WEB_OUTPUT_CONTRACTS)(
        'fails when required output contract %s is absent',
        async (relativePath) => {
            const tempRoot = await createTempProject();
            try {
                await rm(path.join(tempRoot, 'nuxt-output/public', relativePath));
                await expect(validateWebDeployAssets({
                    env: {},
                    projectRoot: tempRoot,
                })).rejects.toThrow(`Missing web build output nuxt-output/public asset: ${relativePath}`);
            } finally {
                await rm(tempRoot, {
                    force: true,
                    recursive: true,
                });
            }
        },
    );
});
