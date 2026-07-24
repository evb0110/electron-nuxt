import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFile,
    readFile,
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
