import { createHash } from 'node:crypto';
import {
    open,
    rm,
} from 'node:fs/promises';
import {
    PINNED_CODEX_CLI_RELEASE_TAG,
    PINNED_CODEX_CLI_VERSION,
    resolvePinnedCodexCliArtifact,
    type IPinnedCodexCliArtifact,
} from '@electron/features/agent/codexCliReleaseManifest';

const MAX_CODEX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_CODEX_DOWNLOAD_REDIRECTS = 3;
const CODEX_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const GITHUB_RELEASE_ORIGIN = 'https://github.com';
const GITHUB_RELEASE_ASSET_ORIGIN = 'https://release-assets.githubusercontent.com';

export function assertPinnedCodexArtifactIdentity(artifact: IPinnedCodexCliArtifact) {
    const pinned = resolvePinnedCodexCliArtifact(artifact.platform, artifact.arch);
    if (
        !pinned
        || artifact.archiveKind !== pinned.archiveKind
        || artifact.assetName !== pinned.assetName
        || artifact.executableEntry !== pinned.executableEntry
        || artifact.sha256 !== pinned.sha256
        || artifact.url !== pinned.url
    ) {
        throw new Error('Codex artifact does not match the checked-in release manifest.');
    }

    const url = new URL(artifact.url);
    const expectedPath = `/openai/codex/releases/download/${PINNED_CODEX_CLI_RELEASE_TAG}/${artifact.assetName}`;
    if (
        url.protocol !== 'https:'
        || url.origin !== GITHUB_RELEASE_ORIGIN
        || url.pathname !== expectedPath
        || url.username !== ''
        || url.password !== ''
        || !url.pathname.includes(`v${PINNED_CODEX_CLI_VERSION}/`)
    ) {
        throw new Error('Codex artifact URL does not match the pinned publisher, version, and asset.');
    }
}

export function assertAllowedCodexDownloadRedirect(fromUrl: string, toUrl: string) {
    const from = new URL(fromUrl);
    const to = new URL(toUrl, from);
    const allowed = to.protocol === 'https:'
        && to.username === ''
        && to.password === ''
        && (
            from.origin === GITHUB_RELEASE_ORIGIN && to.origin === GITHUB_RELEASE_ASSET_ORIGIN
            || from.origin === GITHUB_RELEASE_ASSET_ORIGIN && to.origin === GITHUB_RELEASE_ASSET_ORIGIN
        );
    if (!allowed) {
        throw new Error(`Codex artifact redirect to untrusted origin ${to.origin} was rejected.`);
    }
    return to.href;
}

export function assertPinnedCodexArtifactDigest(
    actualSha256: string,
    artifact: IPinnedCodexCliArtifact,
) {
    if (!/^[0-9a-f]{64}$/u.test(actualSha256) || actualSha256 !== artifact.sha256) {
        throw new Error('Codex artifact SHA-256 digest did not match the checked-in release manifest.');
    }
}

export async function downloadPinnedCodexArtifact(
    artifact: IPinnedCodexCliArtifact,
    destinationPath: string,
    fetchImplementation: typeof fetch = fetch,
) {
    assertPinnedCodexArtifactIdentity(artifact);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), CODEX_DOWNLOAD_TIMEOUT_MS);
    let currentUrl = artifact.url;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        let response: Response | null = null;
        for (let redirectCount = 0; redirectCount <= MAX_CODEX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
            response = await fetchImplementation(currentUrl, {
                redirect: 'manual',
                signal: abortController.signal,
            });
            if (response.status < 300 || response.status >= 400) {
                break;
            }
            const location = response.headers.get('location');
            if (!location || redirectCount === MAX_CODEX_DOWNLOAD_REDIRECTS) {
                throw new Error('Codex artifact download exceeded the trusted redirect limit.');
            }
            currentUrl = assertAllowedCodexDownloadRedirect(currentUrl, location);
        }

        if (!response?.ok || !response.body) {
            throw new Error(`Codex artifact download failed with HTTP status ${response?.status ?? 'unknown'}.`);
        }
        const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_CODEX_ARCHIVE_BYTES) {
            throw new Error('Codex artifact exceeded the maximum allowed archive size.');
        }

        handle = await open(destinationPath, 'wx', 0o600);
        const digest = createHash('sha256');
        const reader = response.body.getReader();
        let receivedBytes = 0;
        for (;;) {
            const {
                done,
                value,
            } = await reader.read();
            if (done) {
                break;
            }
            receivedBytes += value.byteLength;
            if (receivedBytes > MAX_CODEX_ARCHIVE_BYTES) {
                await reader.cancel();
                throw new Error('Codex artifact exceeded the maximum allowed archive size.');
            }
            digest.update(value);
            await handle.write(value);
        }
        await handle.sync();
        assertPinnedCodexArtifactDigest(digest.digest('hex'), artifact);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        handle = null;
        await rm(destinationPath, {force: true}).catch(() => undefined);
        throw error;
    } finally {
        clearTimeout(timeout);
        await handle?.close().catch(() => undefined);
    }
}
