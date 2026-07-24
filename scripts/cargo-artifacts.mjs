import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFile,
    readdir,
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';

export function parseCargoToolBuildRequest(argv, usage) {
    if (argv.includes('--help') || argv.includes('-h')) {
        return {
            dryRun: false,
            help: true,
        };
    }

    const dryRun = argv.includes('--dry-run');
    const positional = argv.filter(arg => arg !== '--dry-run');
    if (positional.length !== 1) {
        throw new Error(usage);
    }

    return {
        dryRun,
        help: false,
        toolId: positional[0],
    };
}

export function parseCargoTargetDirectory(metadataOutput) {
    let metadata;
    try {
        metadata = JSON.parse(metadataOutput);
    } catch (error) {
        throw new Error('Cargo metadata returned invalid JSON', {cause: error});
    }

    if (typeof metadata?.target_directory !== 'string' || !path.isAbsolute(metadata.target_directory)) {
        throw new Error('Cargo metadata did not return an absolute target_directory');
    }

    return metadata.target_directory;
}

export function resolveCargoTargetDirectory({
    env = process.env,
    manifestPath,
    projectRoot,
    runCommand = spawnSync,
}) {
    const cargoArgs = [
        'metadata',
        '--manifest-path',
        manifestPath,
        '--format-version',
        '1',
        '--no-deps',
    ];
    const result = runCommand('cargo', cargoArgs, {
        cwd: projectRoot,
        encoding: 'utf8',
        env,
    });

    if (result.status !== 0) {
        throw new Error(`cargo ${cargoArgs.join(' ')} failed with status ${result.status ?? 'unknown'}: ${result.stderr ?? ''}`.trim());
    }

    return parseCargoTargetDirectory(result.stdout);
}

export function getCargoArtifactPath({
    fileName,
    profile = 'release',
    rustTarget,
    targetDirectory,
}) {
    return path.join(
        targetDirectory,
        ...(rustTarget ? [rustTarget] : []),
        profile,
        fileName,
    );
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export async function copyCargoArtifactVerified(sourcePath, destinationPath) {
    await copyFile(sourcePath, destinationPath);
    const [
        sourceBytes,
        destinationBytes,
    ] = await Promise.all([
        readFile(sourcePath),
        readFile(destinationPath),
    ]);
    const sourceSha256 = sha256(sourceBytes);
    const destinationSha256 = sha256(destinationBytes);

    if (sourceSha256 !== destinationSha256) {
        throw new Error(`Staged Cargo artifact does not match build output: ${destinationPath}`);
    }

    return {
        byteLength: sourceBytes.byteLength,
        sha256: sourceSha256,
    };
}

export function collectCargoSourceInputs(metadata, rootManifestPath) {
    if (
        !metadata
        || !Array.isArray(metadata.packages)
        || typeof metadata.workspace_root !== 'string'
    ) {
        throw new Error('Cargo metadata is missing packages or workspace_root');
    }
    const packagesByRoot = new Map(metadata.packages
        .filter(pkg => typeof pkg?.manifest_path === 'string')
        .map(pkg => [
            path.resolve(path.dirname(pkg.manifest_path)),
            pkg,
        ]));
    const pendingRoots = [path.resolve(path.dirname(rootManifestPath))];
    const visitedRoots = new Set();
    const workspaceRoot = path.resolve(metadata.workspace_root);
    const sourceInputs = [
        path.join(workspaceRoot, 'Cargo.toml'),
        path.join(workspaceRoot, 'Cargo.lock'),
    ];

    while (pendingRoots.length > 0) {
        const packageRoot = pendingRoots.pop();
        if (!packageRoot || visitedRoots.has(packageRoot)) {
            continue;
        }
        visitedRoots.add(packageRoot);
        const pkg = packagesByRoot.get(packageRoot);
        if (!pkg) {
            throw new Error(`Cargo metadata does not describe local package ${packageRoot}`);
        }
        sourceInputs.push(
            path.resolve(pkg.manifest_path),
            path.join(packageRoot, 'src'),
        );
        for (const dependency of pkg.dependencies ?? []) {
            if (typeof dependency?.path === 'string') {
                pendingRoots.push(path.resolve(dependency.path));
            }
        }
    }
    return [...new Set(sourceInputs)];
}

async function newestSourceFile(sourcePaths) {
    let newest = null;
    async function visit(sourcePath) {
        let metadata;
        try {
            metadata = await stat(sourcePath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        if (metadata.isDirectory()) {
            const entries = await readdir(sourcePath, {withFileTypes: true});
            await Promise.all(entries.map(entry => visit(path.join(sourcePath, entry.name))));
            return;
        }
        if (metadata.isFile() && (!newest || metadata.mtimeMs > newest.mtimeMs)) {
            newest = {
                mtimeMs: metadata.mtimeMs,
                path: sourcePath,
            };
        }
    }
    await Promise.all(sourcePaths.map(visit));
    return newest;
}

export async function assertStagedCargoArtifactFresh({
    binaryPath,
    buildCommand,
    sourcePaths,
}) {
    const [
        binaryMetadata,
        newestSource,
    ] = await Promise.all([
        stat(binaryPath),
        newestSourceFile(sourcePaths),
    ]);
    if (!newestSource) {
        throw new Error(`No native sources found for staged binary: ${binaryPath}`);
    }
    if (newestSource.mtimeMs > binaryMetadata.mtimeMs) {
        throw new Error([
            `Stale staged release binary: ${binaryPath}`,
            `Newer native source: ${newestSource.path}`,
            `Run ${buildCommand} to rebuild and restage it.`,
        ].join('\n'));
    }
    return {
        binaryMtimeMs: binaryMetadata.mtimeMs,
        newestSource,
    };
}
