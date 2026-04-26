export function hasDeveloperIdSigningCredentials(env = process.env) {
    return Boolean(env.CSC_LINK && env.CSC_KEY_PASSWORD);
}

export function hasWindowsSigningCredentials(env = process.env) {
    return Boolean(env.WIN_CSC_LINK && env.WIN_CSC_KEY_PASSWORD);
}

export function expectsUpdaterMetadata(target, env = process.env) {
    if (!target.expectsUpdaterMetadata) {
        return false;
    }

    if (target.platform === 'mac' && !hasDeveloperIdSigningCredentials(env)) {
        return false;
    }
    if (target.platform === 'win' && !hasWindowsSigningCredentials(env)) {
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

export function getRequiredArtifactPatterns(target) {
    switch (target.platform) {
        case 'mac':
            return target.arch === 'x64'
                ? [ /\.zip$/ ]
                : [
                    /\.dmg$/,
                    /\.zip$/,
                ];
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
