export const PINNED_CODEX_CLI_VERSION = '0.149.1';
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
        sha256: 'ed60f475c6dda6044c2c00fd7f33273cc3f3f98900ccd1204bfdf2fe935f3405',
    }),
    createArtifact({
        platform: 'darwin',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-apple-darwin.tar.gz',
        executableEntry: 'codex-x86_64-apple-darwin',
        sha256: '85fe7a837eb739dd5e1cc59a9c95b7b682048e5aacdc261505bae768fb1288ef',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'arm64',
        archiveKind: 'tar.gz',
        assetName: 'codex-aarch64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-aarch64-unknown-linux-musl',
        sha256: '14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0',
    }),
    createArtifact({
        platform: 'linux',
        arch: 'x64',
        archiveKind: 'tar.gz',
        assetName: 'codex-x86_64-unknown-linux-musl.tar.gz',
        executableEntry: 'codex-x86_64-unknown-linux-musl',
        sha256: 'e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'arm64',
        archiveKind: 'zip',
        assetName: 'codex-aarch64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-aarch64-pc-windows-msvc.exe',
        sha256: 'd7ab685be68de3e04de93aebd888cafa61280320246ab441b908cd0604df02ef',
    }),
    createArtifact({
        platform: 'win32',
        arch: 'x64',
        archiveKind: 'zip',
        assetName: 'codex-x86_64-pc-windows-msvc.exe.zip',
        executableEntry: 'codex-x86_64-pc-windows-msvc.exe',
        sha256: 'c19dd84738dee791c4d39a96bd080d94f098af074ae9d2ef5e27d3d85a122665',
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
