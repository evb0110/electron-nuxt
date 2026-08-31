import {
    existsSync,
    mkdtempSync,
    rmSync,
} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashFile} from './publish-release-mirror.mjs';
import {RELEASE_TAG_PATTERN} from './releaseTag.mjs';

function runGh(args) {
    return execFileSync('gh', args, {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'inherit',
        ],
    });
}

export async function assertImmutableAsset(localPath, remotePath) {
    const [
        localHash,
        remoteHash,
    ] = await Promise.all([
        hashFile(localPath),
        hashFile(remotePath),
    ]);
    if (localHash !== remoteHash) {
        throw new Error(
            `Immutable release asset mismatch for ${path.basename(localPath)}: local=${localHash} remote=${remoteHash}`,
        );
    }
    return localHash;
}

function getReleaseAssetNames(repo, tag) {
    const release = JSON.parse(runGh([
        'api',
        `repos/${repo}/releases/tags/${tag}`,
    ]));
    return new Set((release.assets ?? []).map(asset => asset.name));
}

function downloadReleaseAsset(repo, tag, assetName, temporaryRoot) {
    const remotePath = path.join(temporaryRoot, assetName);
    if (existsSync(remotePath)) {
        rmSync(remotePath, {force: true});
    }
    runGh([
        'release',
        'download',
        tag,
        '--repo',
        repo,
        '--pattern',
        assetName,
        '--dir',
        temporaryRoot,
    ]);
    if (!existsSync(remotePath)) {
        throw new Error(`GitHub release asset ${assetName} was listed but could not be downloaded for comparison.`);
    }
    return remotePath;
}

/**
 * @param {{assetPaths?: string[], repo?: string, tag?: string}} options
 */
export async function ensureGithubReleaseAssets({
    assetPaths,
    repo = process.env.GH_REPO,
    tag,
} = {}) {
    if (!repo) {
        throw new Error('GH_REPO is required when checking immutable release assets.');
    }
    if (!tag || !RELEASE_TAG_PATTERN.test(tag) || !Array.isArray(assetPaths) || assetPaths.length === 0) {
        throw new Error('Usage: ensure-github-release-assets.mjs <tag> <asset> [asset...]');
    }

    const assetNames = getReleaseAssetNames(repo, tag);
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-asset-'));
    try {
        for (const assetPath of assetPaths) {
            if (!existsSync(assetPath)) {
                throw new Error(`Release asset is missing locally: ${assetPath}`);
            }

            const assetName = path.basename(assetPath);
            if (assetNames.has(assetName)) {
                const remotePath = downloadReleaseAsset(repo, tag, assetName, temporaryRoot);
                await assertImmutableAsset(assetPath, remotePath);
                console.log(`Immutable release asset already matches: ${assetName}`);
                continue;
            }

            runGh([
                'release',
                'upload',
                tag,
                assetPath,
                '--repo',
                repo,
            ]);
            const remotePath = downloadReleaseAsset(repo, tag, assetName, temporaryRoot);
            await assertImmutableAsset(assetPath, remotePath);
            console.log(`Uploaded and verified immutable release asset: ${assetName}`);
            assetNames.add(assetName);
        }
    } finally {
        rmSync(temporaryRoot, {
            force: true,
            recursive: true,
        });
    }
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    try {
        const [
            tag,
            ...assetPaths
        ] = process.argv.slice(2);
        await ensureGithubReleaseAssets({
            assetPaths,
            tag,
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
