export const PINNED_CODEX_CLI_VERSION = '0.144.1';
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
        sha256: '88e72ac8bd30815f7d18e62dac333dc20ce3ad1cba94be1649a1977dd9bfdbb8',
    }),
    createArtifact({
        platform: 'darwin',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-apple-darwin.tar.gz',
        executableEntry: 'codex-x86_64-apple-darwin',
        sha256: '0ea72d21c794504342d5fe0d5d057b0221c0a42f4bdf4a48b95af243af2b0c0e',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'arm64',
        archiveKind: 'tar.gz',
        assetName: 'codex-aarch64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-aarch64-unknown-linux-musl',
        sha256: 'b9f8ef5f98e46ced4dbbd3756a4223e3ee299a457ff488a3305bea455da8b5b8',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-x86_64-unknown-linux-musl',
        sha256: '84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'arm64',
        archiveKind: 'zip',
        assetName: 'codex-aarch64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-aarch64-pc-windows-msvc.exe',
        sha256: '719cd6565996cf3295a1aa8cdf7087420e85210df0fdd7157b17cb6e26eb6879',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'x64',
        archiveKind: 'zip',
        assetName: 'codex-x86_64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-x86_64-pc-windows-msvc.exe',
        sha256: '976844ab2d3d77187b70a10c93f0952d6a58b2f67219734fc37785e4334b4c4a',
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
