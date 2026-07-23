import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createNativeToolBuildPlan } from '@scripts/build-native-tool.mjs';
import { createWasmToolBuildPlan } from '@scripts/build-wasm-tool.mjs';
import { getGeneratedNativeToolResource } from '@scripts/nativeResourceManifest';
import { getWasmArtifactByCrateName } from '@scripts/wasm-artifacts.mjs';

interface ICargoArtifactsModule {
    copyCargoArtifactVerified: (sourcePath: string, destinationPath: string) => Promise<{
        byteLength: number;
        sha256: string;
    }>;
    getCargoArtifactPath: (options: {
        fileName: string;
        profile?: string;
        rustTarget?: string;
        targetDirectory: string;
    }) => string;
    parseCargoToolBuildRequest: (argv: string[], usage: string) => {
        dryRun: boolean;
        help: boolean;
        toolId?: string;
    };
    parseCargoTargetDirectory: (metadataOutput: string) => string;
    resolveCargoTargetDirectory: (options: {
        env?: NodeJS.ProcessEnv;
        manifestPath: string;
        projectRoot: string;
        runCommand?: (command: string, args: string[], options: {
            cwd: string;
            encoding: string;
            env: NodeJS.ProcessEnv;
        }) => {
            status: number | null;
            stderr: string;
            stdout: string;
        };
    }) => string;
}

const {
    copyCargoArtifactVerified,
    getCargoArtifactPath,
    parseCargoToolBuildRequest,
    parseCargoTargetDirectory,
    resolveCargoTargetDirectory,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/cargo-artifacts.mjs')).href
) as ICargoArtifactsModule;

describe('Cargo artifact staging', () => {
    it('shares strict CLI parsing across native and WASM tool builders', () => {
        expect(parseCargoToolBuildRequest(['pdf-search'], 'usage')).toEqual({
            dryRun: false,
            help: false,
            toolId: 'pdf-search',
        });
        expect(parseCargoToolBuildRequest([
            'pdf-page-ops',
            '--dry-run',
        ], 'usage')).toEqual({
            dryRun: true,
            help: false,
            toolId: 'pdf-page-ops',
        });
        expect(parseCargoToolBuildRequest(['--help'], 'usage')).toEqual({
            dryRun: false,
            help: true,
        });
        expect(() => parseCargoToolBuildRequest([], 'expected usage')).toThrow('expected usage');
        expect(() => parseCargoToolBuildRequest([
            'one',
            'two',
        ], 'expected usage'))
            .toThrow('expected usage');
    });

    it('uses Cargo metadata as the authority for a shared workspace target directory', () => {
        const runCommand = vi.fn(() => ({
            status: 0,
            stderr: '',
            stdout: JSON.stringify({target_directory: '/checkout/native/target'}),
        }));

        expect(resolveCargoTargetDirectory({
            env: {CARGO_TARGET_DIR: '/cache/overridden-target'},
            manifestPath: 'native/pdf-search/Cargo.toml',
            projectRoot: '/checkout',
            runCommand,
        })).toBe('/checkout/native/target');
        expect(runCommand).toHaveBeenCalledWith('cargo', [
            'metadata',
            '--manifest-path',
            'native/pdf-search/Cargo.toml',
            '--format-version',
            '1',
            '--no-deps',
        ], expect.objectContaining({
            cwd: '/checkout',
            env: {CARGO_TARGET_DIR: '/cache/overridden-target'},
        }));
    });

    it('resolves host, cross-target, and WASM artifacts under the metadata target directory', () => {
        expect(getCargoArtifactPath({
            fileName: 'evb-pdf-search',
            targetDirectory: '/checkout/native/target',
        })).toBe('/checkout/native/target/release/evb-pdf-search');
        expect(getCargoArtifactPath({
            fileName: 'evb-pdf-search.exe',
            rustTarget: 'aarch64-pc-windows-msvc',
            targetDirectory: '/shared/cargo-target',
        })).toBe('/shared/cargo-target/aarch64-pc-windows-msvc/release/evb-pdf-search.exe');
        expect(getCargoArtifactPath({
            fileName: 'evb_pdf_page_ops.wasm',
            rustTarget: 'wasm32-unknown-unknown',
            targetDirectory: '/checkout/native/target',
        })).toBe('/checkout/native/target/wasm32-unknown-unknown/release/evb_pdf_page_ops.wasm');
    });

    it('rejects malformed or non-absolute Cargo metadata paths', () => {
        expect(() => parseCargoTargetDirectory('{')).toThrow('invalid JSON');
        expect(() => parseCargoTargetDirectory(JSON.stringify({target_directory: 'native/target'})))
            .toThrow('absolute target_directory');
    });

    it('proves staged bytes are identical to the Cargo build output', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-cargo-artifact-'));
        const sourcePath = path.join(tempRoot, 'native', 'target', 'release', 'evb-pdf-search');
        const destinationPath = path.join(tempRoot, '.tmp', 'pdf-search', 'darwin-arm64', 'bin', 'evb-pdf-search');
        const sourceBytes = Buffer.from('fresh-workspace-binary');

        try {
            await mkdir(path.dirname(sourcePath), {recursive: true});
            await mkdir(path.dirname(destinationPath), {recursive: true});
            await writeFile(sourcePath, sourceBytes);

            await expect(copyCargoArtifactVerified(sourcePath, destinationPath)).resolves.toEqual({
                byteLength: sourceBytes.byteLength,
                sha256: 'e409a299ecb918b9fada7382ed9437d1f7f2918c4ba3e6984be9a2737aff0625',
            });
            await expect(readFile(destinationPath)).resolves.toEqual(sourceBytes);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('derives every native and WASM staging plan from artifact manifests', async () => {
        for (const toolId of [
            'pdf-image-combine',
            'pdf-page-ops',
            'pdf-search',
            'scan-cleanup',
        ]) {
            const tool = getGeneratedNativeToolResource(toolId);
            const plan = createNativeToolBuildPlan({
                projectRoot: '/repo',
                target: {
                    binaryExtension: '.exe',
                    cargoTargetArgs: [
                        '--target',
                        'aarch64-pc-windows-msvc',
                    ],
                    isHostTarget: false,
                    platform: 'win32',
                    platformArch: 'win32-arm64',
                    rustTarget: 'aarch64-pc-windows-msvc',
                },
                tool,
            });
            expect(plan.manifestPath).toBe(`native/${tool.crateName}/Cargo.toml`);
            expect(plan.destinationPath).toBe(path.join(
                '/repo',
                '.tmp',
                tool.stagingName,
                'win32-arm64',
                'bin',
                `${tool.binaryName}.exe`,
            ));
            expect(plan.rustTarget).toBe('aarch64-pc-windows-msvc');
        }

        for (const toolId of [
            'pdf-image-combine',
            'pdf-page-ops',
        ]) {
            const tool = getGeneratedNativeToolResource(toolId);
            const artifact = getWasmArtifactByCrateName(tool.crateName);
            const plan = createWasmToolBuildPlan({
                artifact,
                env: {RUSTFLAGS: '--cfg existing'},
                projectRoot: '/repo',
            });
            expect(plan.manifestPath).toBe(`native/${tool.crateName}/Cargo.toml`);
            expect(plan.destinationPath).toBe(path.join('/repo', artifact.publicRelativePath));
            expect(plan.requiredExports).toBe(artifact.requiredExports);
            expect(plan.rustflags).toContain('--cfg existing');
        }
        expect(() => getWasmArtifactByCrateName('pdf-search')).toThrow(
            'Unknown WASM artifact crate: pdf-search',
        );

        const benchmarkSource = await readFile(
            path.join(process.cwd(), 'scripts', 'benchmark-native-release-profiles.mjs'),
            'utf8',
        );
        expect(benchmarkSource).toContain('resolveCargoTargetDirectory');
        expect(benchmarkSource).not.toContain('native/pdf-search/target');
        expect(benchmarkSource).not.toContain('native/pdf-image-combine/target');
    });
});
