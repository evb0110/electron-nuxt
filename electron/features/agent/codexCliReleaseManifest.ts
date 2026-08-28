export const PINNED_CODEX_CLI_VERSION = '0.150.1';
export const PINNED_CODEX_CLI_RELEASE_TAG = `rust-v${PINNED_CODEX_CLI_VERSION}`;

export interface IPinnedCodexCliArtifact {
    platform: 'darwin' | 'linux' | 'win32';
    arch: 'arm64' | 'x64';
    archiveKind: 'tar.gz' | 'zip';
    assetName: string;
    executableEntry: string;
    sha256: string;
    url: string;
}

type TArtifactSeed = Omit<IPinnedCodexCliArtifact, 'url'>;

function createArtifact(seed: TArtifactSeed): IPinnedCodexCliArtifact {
    return {
        ...seed,
        url: `https://github.com/openai/codex/releases/download/${PINNED_CODEX_CLI_RELEASE_TAG}/${seed.assetName}`,
    };
}

export const PINNED_CODEX_CLI_ARTIFACTS: readonly IPinnedCodexCliArtifact[] = [
    createArtifact({
        platform: 'darwin',
        arch: 'arm64',
        archiveKind: 'tar.gz',
        assetName: 'codex-aarch64-apple-darwin.tar.gz',
        executableEntry: 'codex-aarch64-apple-darwin',
        sha256: 'f66f1c45f1eda49d6a8aef86faee24121b0c8913cd9023f23ee44262606fc7b6',
    }),
    createArtifact({
        platform: 'darwin',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-apple-darwin.tar.gz',
        executableEntry: 'codex-x86_64-apple-darwin',
        sha256: 'd00bdeb113c2cb42b43fbe4916b681ab1405772ac38fc8ac7fa9cc0934d1d0aa',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'arm64',
        archiveKind: 'tar.gz',
        assetName: 'codex-aarch64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-aarch64-unknown-linux-musl',
        sha256: '5bb1f75e1a1588845b4a31f2c98fb2b394be5c2a8d90a24a8ab0ebbae1169264',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-x86_64-unknown-linux-musl',
        sha256: 'ab308870bc7fc048c23dc49d03f6b8af9ce7fc99b9da882d6688be7a90155c7a',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'arm64',
        archiveKind: 'zip',
        assetName: 'codex-aarch64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-aarch64-pc-windows-msvc.exe',
        sha256: '589e1c49d7b0fac369913c5f8195b49bd6fd458954ed47cd76c9b7e8f46eb056',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'x64',
        archiveKind: 'zip',
        assetName: 'codex-x86_64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-x86_64-pc-windows-msvc.exe',
        sha256: '6b4b13811c2e0a2dc7a79ad94686b7b665e69407c9dc25cdbc2dadfc31dd8e19',
    }),
] as const;

export function resolvePinnedCodexCliArtifact(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
) {
    if (
        (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
        || (arch !== 'arm64' && arch !== 'x64')
    ) {
        return null;
    }
    return PINNED_CODEX_CLI_ARTIFACTS.find(artifact => (
        artifact.platform === platform && artifact.arch === arch
    )) ?? null;
}
