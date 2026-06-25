import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {
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
    vi,
} from 'vitest';

interface IWasmFreshnessArtifact {
    builtFileName: string;
    crateName: string;
    label: string;
    manifestPath: string;
    publicRelativePath: string;
    requiredExports: string[];
    rustflags: string[];
}

interface IWasmFreshnessModule {
    WASM_FRESHNESS_ARTIFACTS: IWasmFreshnessArtifact[];
    checkWasmFreshness: (options?: {
        artifacts?: IWasmFreshnessArtifact[];
        mode?: string;
        projectRoot?: string;
        runCommand?: (command: string, args: string[], options: {
            cwd: string;
            env: NodeJS.ProcessEnv;
            stdio: string
        }) => void;
    }) => Promise<Array<{
        builtByteLength: number;
        fresh: boolean;
        mode: string;
        publicPath: string
    }>>;
    getWasmFreshnessBuildPlan: (artifact: IWasmFreshnessArtifact, options: {
        env?: NodeJS.ProcessEnv;
        projectRoot: string;
    }) => {
        builtPath: string;
        cargoArgs: string[];
        cargoEnv: NodeJS.ProcessEnv;
        cargoTargetDir: string;
        publicPath: string;
    };
}

interface IRequiredWebWasmAsset {
    relativePath: string;
    requiredExports: string[];
}

interface IWasmArtifactModule {REQUIRED_WEB_WASM_ASSETS: IRequiredWebWasmAsset[];}

const {
    WASM_FRESHNESS_ARTIFACTS,
    checkWasmFreshness,
    getWasmFreshnessBuildPlan,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/check-wasm-freshness.mjs')).href
) as IWasmFreshnessModule;
const { REQUIRED_WEB_WASM_ASSETS } = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/wasm-artifacts.mjs')).href
) as IWasmArtifactModule;

const WASM_FRESHNESS_TEST_TIMEOUT_MS = 20_000;

async function createTempProject(artifact: IWasmFreshnessArtifact) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-wasm-freshness-'));
    const publicPath = path.join(tempRoot, artifact.publicRelativePath);
    await mkdir(path.dirname(publicPath), {recursive: true});
    copyFileSync(path.join(process.cwd(), artifact.publicRelativePath), publicPath);
    return tempRoot;
}

describe('WASM freshness check', () => {
    it('uses the shared web WASM exports and page-ops getrandom rustflags', () => {
        const requiredExportsByPublicPath = new Map(
            REQUIRED_WEB_WASM_ASSETS.map(asset => [
                `public/${asset.relativePath}`,
                asset.requiredExports,
            ]),
        );

        for (const artifact of WASM_FRESHNESS_ARTIFACTS) {
            expect(artifact.requiredExports).toEqual(requiredExportsByPublicPath.get(artifact.publicRelativePath));
        }

        const pageOpsArtifact = WASM_FRESHNESS_ARTIFACTS.find(artifact => artifact.crateName === 'pdf-page-ops');
        expect(pageOpsArtifact).toBeDefined();
        expect(pageOpsArtifact?.rustflags).toEqual(['--cfg getrandom_backend="custom"']);
        expect(getWasmFreshnessBuildPlan(pageOpsArtifact!, {projectRoot: '/tmp/project'}).cargoEnv.RUSTFLAGS)
            .toBe('--cfg getrandom_backend="custom"');
        expect(getWasmFreshnessBuildPlan(pageOpsArtifact!, {
            projectRoot: '/tmp/project',
            env: {RUSTFLAGS: '-C opt-level=z'},
        }).cargoEnv.RUSTFLAGS).toBe('-C opt-level=z --cfg getrandom_backend="custom"');
    });

    it('compares fresh Cargo output with public WASM without updating the public artifact', async () => {
        const artifact = WASM_FRESHNESS_ARTIFACTS[0]!;
        const tempRoot = await createTempProject(artifact);
        const originalPublicBytes = readFileSync(path.join(tempRoot, artifact.publicRelativePath));
        const runCommand = vi.fn(() => {
            const plan = getWasmFreshnessBuildPlan(artifact, {projectRoot: tempRoot});
            mkdirSync(path.dirname(plan.builtPath), {recursive: true});
            writeFileSync(plan.builtPath, originalPublicBytes);
        });

        try {
            const result = await checkWasmFreshness({
                artifacts: [artifact],
                projectRoot: tempRoot,
                runCommand,
            });

            expect(result).toEqual([expect.objectContaining({fresh: true})]);
            expect(readFileSync(path.join(tempRoot, artifact.publicRelativePath))).toEqual(originalPublicBytes);
            expect(runCommand).toHaveBeenCalledWith(
                'cargo',
                expect.arrayContaining([
                    'build',
                    '--target',
                    'wasm32-unknown-unknown',
                    '--lib',
                ]),
                expect.objectContaining({
                    cwd: tempRoot,
                    env: expect.objectContaining({CARGO_TARGET_DIR: path.join(tempRoot, '.tmp', 'wasm-freshness', artifact.crateName, 'target')}),
                    stdio: 'inherit',
                }),
            );
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    }, WASM_FRESHNESS_TEST_TIMEOUT_MS);

    it('fails when the committed public WASM differs from the fresh build', async () => {
        const artifact = {
            ...WASM_FRESHNESS_ARTIFACTS[0]!,
            builtFileName: 'fresh.wasm',
            label: 'Test WASM',
            publicRelativePath: 'public/wasm/test.wasm',
            requiredExports: [],
        };
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-wasm-freshness-'));
        const publicPath = path.join(tempRoot, artifact.publicRelativePath);
        const publicBytes = readFileSync(path.join(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm'));
        const freshBytes = readFileSync(path.join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
        const runCommand = vi.fn(() => {
            const plan = getWasmFreshnessBuildPlan(artifact, {projectRoot: tempRoot});
            mkdirSync(path.dirname(plan.builtPath), {recursive: true});
            writeFileSync(plan.builtPath, freshBytes);
        });

        try {
            await mkdir(path.dirname(publicPath), {recursive: true});
            writeFileSync(publicPath, publicBytes);

            await expect(checkWasmFreshness({
                artifacts: [artifact],
                projectRoot: tempRoot,
                runCommand,
            })).rejects.toThrow('Committed WASM artifacts are stale');
            expect(readFileSync(publicPath)).toEqual(publicBytes);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    }, WASM_FRESHNESS_TEST_TIMEOUT_MS);

    it('allows byte differences in portable mode while still reporting freshness', async () => {
        const artifact = {
            ...WASM_FRESHNESS_ARTIFACTS[0]!,
            builtFileName: 'fresh.wasm',
            label: 'Portable WASM',
            publicRelativePath: 'public/wasm/portable.wasm',
            requiredExports: [],
        };
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-wasm-freshness-'));
        const publicPath = path.join(tempRoot, artifact.publicRelativePath);
        const publicBytes = readFileSync(path.join(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm'));
        const freshBytes = readFileSync(path.join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
        const runCommand = vi.fn(() => {
            const plan = getWasmFreshnessBuildPlan(artifact, {projectRoot: tempRoot});
            mkdirSync(path.dirname(plan.builtPath), {recursive: true});
            writeFileSync(plan.builtPath, freshBytes);
        });

        try {
            await mkdir(path.dirname(publicPath), {recursive: true});
            writeFileSync(publicPath, publicBytes);

            await expect(checkWasmFreshness({
                artifacts: [artifact],
                mode: 'portable',
                projectRoot: tempRoot,
                runCommand,
            })).resolves.toEqual([expect.objectContaining({
                fresh: false,
                mode: 'portable',
            })]);
            expect(readFileSync(publicPath)).toEqual(publicBytes);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    }, WASM_FRESHNESS_TEST_TIMEOUT_MS);
});
