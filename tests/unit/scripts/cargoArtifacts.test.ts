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
    parseCargoTargetDirectory,
    resolveCargoTargetDirectory,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/cargo-artifacts.mjs')).href
) as ICargoArtifactsModule;

describe('Cargo artifact staging', () => {
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

    it('keeps every native and WASM staging script metadata-driven', async () => {
        const scriptNames = [
            'build-pdf-image-combine.mjs',
            'build-pdf-page-ops.mjs',
            'build-pdf-search.mjs',
            'build-pdf-image-combine-wasm.mjs',
            'build-pdf-page-ops-wasm.mjs',
        ];

        for (const scriptName of scriptNames) {
            const source = await readFile(path.join(process.cwd(), 'scripts', scriptName), 'utf8');
            expect(source).toContain('resolveCargoTargetDirectory');
            expect(source).toContain('copyCargoArtifactVerified');
            expect(source).not.toMatch(/artifact\.crateName,[\s\S]{0,80}['"]target['"]/);
        }

        const benchmarkSource = await readFile(
            path.join(process.cwd(), 'scripts', 'benchmark-native-release-profiles.mjs'),
            'utf8',
        );
        expect(benchmarkSource).toContain('resolveCargoTargetDirectory');
        expect(benchmarkSource).not.toContain('native/pdf-search/target');
        expect(benchmarkSource).not.toContain('native/pdf-image-combine/target');
    });
});
