export function hasDeveloperIdSigningCredentials(env = process.env) {
    return Boolean(env.CSC_LINK && env.CSC_KEY_PASSWORD);
}

export function hasWindowsSigningCredentials(env = process.env) {
    return Boolean(env.WIN_CSC_LINK && env.WIN_CSC_KEY_PASSWORD);
}

const GATE_POLICY_MANIFEST = Object.freeze({
    ci: {changedAreas: {nativeOrBuild: {
        owner: 'pr_native_build_safety',
        paths: [
            'native/**',
            'scripts/bundle-*.sh',
            'scripts/build-*.mjs',
            'scripts/check-build-*.mjs',
            'scripts/check-drizzle-schema.mjs',
            'scripts/check-electron-builder-asar-unpack.mjs',
            'scripts/check-generated-native-resources.mjs',
            'scripts/check-native-tools-source-matrix.sh',
            'scripts/check-wasm-freshness.mjs',
            'scripts/native-rust-targets.mjs',
            'scripts/prune-build-artifacts.mjs',
            'scripts/release/**',
            'scripts/run-workspace-package-typecheck.mjs',
            'scripts/run-build-strict.mjs',
            'scripts/verify-packaged-native-tools.sh',
            'scripts/wasm-artifacts.mjs',
            'scripts/workspace-roots.mjs',
            'pnpm-workspace.yaml',
            'electron-builder.yml',
            'package.json',
            'pnpm-lock.yaml',
        ],
    }}},
    release: {
        localChecks: {
            gateGroups: [
                {
                    id: 'lint-static',
                    owner: 'release',
                    scripts: [
                        'lint',
                        'check:static:reports',
                        'check:static:assets',
                        'typecheck',
                        'typecheck:coverage',
                        'check:drizzle-schema',
                        'check:electron:install',
                        'check:electron-builder:asar-unpack',
                        'build:pdf-image-combine',
                        'build:pdf-page-ops',
                        'build:pdf-search',
                        'check:generated-native-resources:host',
                        'check:resources:matrix',
                        'check:wasm:portable',
                        'check:architecture:source-size',
                        'fallow:all',
                    ],
                },
                {
                    id: 'release-critical-tests',
                    owner: 'release',
                    scripts: [
                        'test:rust',
                        'test:coverage',
                        'test:bundle-integrity',
                    ],
                },
            ],
            owner: 'release',
        },
        localVerify: {
            gates: [
                {
                    args: [
                        'run',
                        'release:verify:checks',
                    ],
                    command: 'pnpm',
                    id: 'checks',
                    owner: 'release',
                },
                {
                    args: [
                        'run',
                        'release:verify:package:local',
                    ],
                    command: 'pnpm',
                    id: 'package-local',
                    owner: 'release',
                },
            ],
            owner: 'release',
        },
    },
    schemaVersion: 1,
});

function cloneGateCommand(gate) {
    return {
        args: [...gate.args],
        command: gate.command,
    };
}

export function getGatePolicyManifest() {
    return {
        ci: {changedAreas: {nativeOrBuild: {
            owner: GATE_POLICY_MANIFEST.ci.changedAreas.nativeOrBuild.owner,
            paths: [...GATE_POLICY_MANIFEST.ci.changedAreas.nativeOrBuild.paths],
        }}},
        release: {
            localChecks: {
                gateGroups: GATE_POLICY_MANIFEST.release.localChecks.gateGroups.map(group => ({
                    id: group.id,
                    owner: group.owner,
                    scripts: [...group.scripts],
                })),
                owner: GATE_POLICY_MANIFEST.release.localChecks.owner,
            },
            localVerify: {
                gates: GATE_POLICY_MANIFEST.release.localVerify.gates.map(gate => ({
                    ...cloneGateCommand(gate),
                    id: gate.id,
                    owner: gate.owner,
                })),
                owner: GATE_POLICY_MANIFEST.release.localVerify.owner,
            },
        },
        schemaVersion: GATE_POLICY_MANIFEST.schemaVersion,
    };
}

export function getNativeOrBuildChangedAreaPaths() {
    return [...GATE_POLICY_MANIFEST.ci.changedAreas.nativeOrBuild.paths];
}

export function getLocalReleaseCheckGateScripts() {
    return GATE_POLICY_MANIFEST.release.localChecks.gateGroups
        .flatMap(group => group.scripts);
}

export function getLocalReleaseVerifyGateCommands() {
    return GATE_POLICY_MANIFEST.release.localVerify.gates.map(cloneGateCommand);
}

export function expectsUpdaterMetadata(target, env = process.env) {
    if (!target.expectsUpdaterMetadata) {
        return false;
    }

    if (target.platform === 'mac' && !hasMacPublishUpdaterMetadataPolicy(env)) {
        return false;
    }
    if (target.platform === 'win' && !hasWindowsPublishUpdaterMetadataPolicy(env)) {
        return false;
    }

    return true;
}

export function detectHostReleasePlatform(nodePlatform = process.platform) {
    switch (nodePlatform) {
        case 'darwin':
            return 'mac';
        case 'linux':
            return 'linux';
        case 'win32':
            return 'win';
        default:
            throw new Error(`Unsupported local release platform "${nodePlatform}"`);
    }
}

export function getLocalReleaseTargets(options = {}) {
    const platform = detectHostReleasePlatform(options.platform ?? process.platform);
    const arch = options.arch ?? process.arch;

    if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Unsupported local release arch "${arch}"`);
    }

    // Local packaging verifies the current host package only. Cross-arch macOS
    // packages require matching bundled native-tool resources and are covered by
    // the GitHub release/build matrix on the corresponding runner architecture.
    const targetArchs = [arch];

    return targetArchs.map((targetArch) => ({
        arch: targetArch,
        expectsUpdaterMetadata: (
            (platform === 'mac' && targetArch === 'arm64')
            || (platform === 'win' && targetArch === 'x64')
        ),
        isPrimaryHostTarget: targetArch === arch,
        platform,
    }));
}

export function getRequiredArtifactPatterns(target, env = process.env) {
    switch (target.platform) {
        case 'mac':
            if (target.arch === 'x64') {
                return [ /\.zip$/ ];
            }

            // Unsigned local mac verification prunes updater metadata; the DMG
            // is the release-critical manual-install artifact in that mode.
            return expectsUpdaterMetadata(target, env)
                ? [
                    /\.dmg$/,
                    /\.zip$/,
                ]
                : [ /\.dmg$/ ];
        case 'linux':
            return [
                /\.AppImage$/,
                /\.deb$/,
            ];
        case 'win':
            return [ /\.exe$/ ];
        default:
            return [];
    }
}

export function shouldVerifyPackagedStartup(target, env = process.env) {
    return target.platform === 'mac' && hasDeveloperIdSigningCredentials(env);
}

export function hasMacPublishUpdaterMetadataPolicy(env = process.env) {
    if (env.EVB_RELEASE_HAS_MAC_SIGNING === 'true') {
        return true;
    }
    if (env.EVB_RELEASE_HAS_MAC_SIGNING === 'false') {
        return false;
    }
    return hasDeveloperIdSigningCredentials(env);
}

export function hasWindowsPublishUpdaterMetadataPolicy(env = process.env) {
    if (env.EVB_RELEASE_HAS_WINDOWS_SIGNING === 'true') {
        return true;
    }
    if (env.EVB_RELEASE_HAS_WINDOWS_SIGNING === 'false') {
        return false;
    }
    return hasWindowsSigningCredentials(env);
}

export function assertPublishUpdaterMetadataPolicy(artifactNames, env = process.env) {
    const files = [...artifactNames];
    const hasMacPolicy = hasMacPublishUpdaterMetadataPolicy(env);
    const hasWindowsPolicy = hasWindowsPublishUpdaterMetadataPolicy(env);
    const forbidden = files.filter((fileName) => {
        if (/^latest-mac.*\.yml$/u.test(fileName)) {
            return !hasMacPolicy;
        }
        if (/^latest(?:-win(?:-.*)?)?\.yml$/u.test(fileName)) {
            return !hasWindowsPolicy;
        }
        if (/^latest.*\.yml$/u.test(fileName)) {
            return true;
        }
        if (fileName.endsWith('.dmg.blockmap') || fileName.endsWith('.zip.blockmap')) {
            return !hasMacPolicy;
        }
        if (fileName.endsWith('.exe.blockmap')) {
            return !hasWindowsPolicy;
        }
        return fileName.endsWith('.blockmap');
    });

    if (forbidden.length > 0) {
        throw new Error(
            'Release artifacts include updater metadata forbidden by publish policy: '
            + forbidden.sort().join(', '),
        );
    }
}

export function getUpdaterMetadataFileNames(artifactNames) {
    return [...artifactNames].filter(fileName => /^latest.*\.yml$/u.test(fileName));
}

function assertSafeArtifactReference(metadataFileName, artifactPath) {
    if (
        artifactPath.startsWith('/')
        || /^[A-Za-z]:[\\/]/u.test(artifactPath)
        || artifactPath.split(/[\\/]/u).some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
        throw new Error(`Unsafe path entry in ${metadataFileName}: ${artifactPath}`);
    }

    return artifactPath;
}

export function parseUpdaterMetadataPath(metadataFileName, metadataText) {
    const pathLine = metadataText
        .split(/\r?\n/u)
        .find(line => /^path:\s*/u.test(line));

    if (!pathLine) {
        throw new Error(`Missing path entry in ${metadataFileName}`);
    }

    const match = pathLine.match(/^path:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
    if (!match) {
        throw new Error(`Unsupported path entry in ${metadataFileName}: ${pathLine}`);
    }

    return assertSafeArtifactReference(metadataFileName, match[1] ?? match[2] ?? match[3]);
}

export function parseUpdaterMetadataFileUrls(metadataFileName, metadataText) {
    const urls = [];

    for (const line of metadataText.split(/\r?\n/u)) {
        const match = line.match(/^\s*(?:-\s*)?url:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
        if (!match) {
            continue;
        }
        urls.push(assertSafeArtifactReference(metadataFileName, match[1] ?? match[2] ?? match[3]));
    }

    return urls;
}

export function assertPublishUpdaterMetadataReferences(artifactNames, readMetadataText) {
    const files = [...artifactNames];
    const artifactSet = new Set(files);
    const metadataFileNames = getUpdaterMetadataFileNames(files);

    if (metadataFileNames.length === 0) {
        return false;
    }

    for (const metadataFileName of metadataFileNames) {
        const metadataText = readMetadataText(metadataFileName);
        const referencedArtifacts = new Set([
            parseUpdaterMetadataPath(metadataFileName, metadataText),
            ...parseUpdaterMetadataFileUrls(metadataFileName, metadataText),
        ]);

        for (const artifactPath of referencedArtifacts) {
            if (!artifactSet.has(artifactPath)) {
                throw new Error(
                    `Updater metadata mismatch in ${metadataFileName} -> ${artifactPath} not found. `
                    + `Available artifacts: ${files.sort().join(', ')}`,
                );
            }
        }
    }

    return true;
}

export function createReleaseVerificationEnvs(baseEnv = process.env) {
    const releaseCiEnv = {
        ...baseEnv,
        CI: 'true',
    };

    return {
        releaseAutomationEnv: {
            ...releaseCiEnv,
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        },
        releaseCiEnv,
    };
}

export function getReleaseCiEnv(baseEnv = process.env) {
    return createReleaseVerificationEnvs(baseEnv).releaseCiEnv;
}

export function getReleaseAutomationEnv(baseEnv = process.env) {
    return createReleaseVerificationEnvs(baseEnv).releaseAutomationEnv;
}
