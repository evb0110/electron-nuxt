import {
    existsSync,
    readFileSync,
    readdirSync,
    rmSync,
    unlinkSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import { run } from './shared.mjs';

const RELEASE_DIR = 'release';

function hasDeveloperIdSigningCredentials() {
    return Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
}

function hasWindowsSigningCredentials() {
    return Boolean(process.env.WIN_CSC_LINK && process.env.WIN_CSC_KEY_PASSWORD);
}

function expectsUpdaterMetadata(target) {
    if (!target.expectsUpdaterMetadata) {
        return false;
    }

    // Release CI prunes updater metadata for unsigned desktop targets. Keep
    // local verification aligned so we catch feed-shape drift before tagging.
    if (target.platform === 'mac' && !hasDeveloperIdSigningCredentials()) {
        return false;
    }
    if (target.platform === 'win' && !hasWindowsSigningCredentials()) {
        return false;
    }

    return true;
}

function getLocalReleaseTargets() {
    let platform;
    switch (process.platform) {
        case 'darwin':
            platform = 'mac';
            break;
        case 'linux':
            platform = 'linux';
            break;
        case 'win32':
            platform = 'win';
            break;
        default:
            throw new Error(`Unsupported local release platform "${process.platform}"`);
    }

    if (process.arch !== 'arm64' && process.arch !== 'x64') {
        throw new Error(`Unsupported local release arch "${process.arch}"`);
    }

    const targetArchs = (
        platform === 'mac' && process.arch === 'arm64'
            ? [
                'arm64',
                'x64',
            ]
            : [process.arch]
    );

    return targetArchs.map((arch) => ({
        arch,
        expectsUpdaterMetadata: (
            (platform === 'mac' && arch === 'arm64')
            || (platform === 'win' && arch === 'x64')
        ),
        isPrimaryHostTarget: arch === process.arch,
        platform,
    }));
}

function getPackagingArgs(target) {
    if (target.platform === 'mac' && target.arch === 'x64') {
        return [
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'zip',
            '--x64',
        ];
    }

    return [
        'exec',
        'electron-builder',
        '--publish',
        'never',
        `--${target.platform}`,
        `--${target.arch}`,
    ];
}

function assertReleaseArtifactsExist(target) {
    const distDir = resolve(process.cwd(), RELEASE_DIR);
    if (!existsSync(distDir)) {
        throw new Error(`${RELEASE_DIR}/ was not created by electron-builder`);
    }

    const files = readdirSync(distDir);
    const requiredPatterns = (() => {
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
    })();

    for (const pattern of requiredPatterns) {
        const matched = files.some(file => pattern.test(file));
        if (!matched) {
            throw new Error(`Missing packaged artifact matching ${pattern} in ${RELEASE_DIR}/`);
        }
    }
}

function readUpdaterArtifactPath(yamlPath) {
    const raw = readFileSync(yamlPath, 'utf8');
    const match = raw.match(/^path:\s*(.+)\s*$/m);
    if (!match) {
        throw new Error(`Missing path entry in ${yamlPath}`);
    }

    return match[1]
        .trim()
        .replace(/^['"]/, '')
        .replace(/['"]$/, '');
}

function validateUpdaterMetadata(target) {
    const shouldExist = expectsUpdaterMetadata(target);
    const distDir = resolve(process.cwd(), RELEASE_DIR);
    const ymlFiles = readdirSync(distDir)
        .filter(name => /^latest.*\.yml$/.test(name))
        .map(name => join(distDir, name));
    const blockmaps = readdirSync(distDir)
        .filter(name => name.endsWith('.blockmap'));

    if (!shouldExist) {
        if (ymlFiles.length > 0 || blockmaps.length > 0) {
            throw new Error(
                `Unexpected updater metadata for ${target.platform}-${target.arch}; `
                + 'this target should ship without latest*.yml/blockmap files.',
            );
        }
        return;
    }

    if (ymlFiles.length === 0) {
        throw new Error(`No latest*.yml files found in ${RELEASE_DIR}/`);
    }

    for (const ymlPath of ymlFiles) {
        const relPath = readUpdaterArtifactPath(ymlPath);
        if (!relPath) {
            throw new Error(`Missing path entry in ${ymlPath}`);
        }

        const artifactPath = join(distDir, relPath);
        if (!existsSync(artifactPath)) {
            throw new Error(`Updater metadata mismatch in ${ymlPath} -> ${relPath} not found`);
        }
    }
}

function verifyLocalPackageArtifacts(target) {
    if (target.platform === 'mac' && target.arch !== process.arch) {
        const appDir = resolve(
            process.cwd(),
            target.arch === 'x64'
                ? `${RELEASE_DIR}/mac/EVB Viewer.app`
                : `${RELEASE_DIR}/mac-${target.arch}/EVB Viewer.app`,
        );
        run('codesign', [
            '--verify',
            '--deep',
            '--strict',
            '--verbose=2',
            appDir,
        ], { stdio: 'inherit' });
        process.stdout.write(
            `Cross-arch local verification passed for ${target.platform}-${target.arch} packaging/signature path.\n`,
        );
        return;
    }

    run('bash', [
        'scripts/verify-packaged-native-tools.sh',
        target.platform,
        target.arch,
    ], {stdio: 'inherit'});

    if (target.platform === 'mac' && hasDeveloperIdSigningCredentials()) {
        run('bash', [
            'scripts/verify-packaged-startup.sh',
            target.platform,
            target.arch,
        ], {stdio: 'inherit'});
    } else if (target.platform === 'mac') {
        process.stdout.write(
            'Skipping packaged startup verification for ad-hoc local mac build; '
            + 'LaunchServices/Developer ID semantics are only reproducible when signing credentials are present.\n',
        );
    }
}

function pruneUpdaterMetadataForLocalParity(target) {
    if (expectsUpdaterMetadata(target)) {
        return;
    }

    const distDir = resolve(process.cwd(), RELEASE_DIR);
    for (const entry of readdirSync(distDir)) {
        if (/^latest.*\.yml$/.test(entry) || entry.endsWith('.blockmap')) {
            unlinkSync(join(distDir, entry));
        }
    }
}

function main() {
    const targets = getLocalReleaseTargets();
    const distDir = resolve(process.cwd(), RELEASE_DIR);

    for (const target of targets) {
        rmSync(distDir, {
            force: true,
            recursive: true,
        });

        const env = { ...process.env };
        if (target.platform === 'linux') {
            env.USE_SYSTEM_FPM = 'true';
        }

        process.stdout.write(
            `Packaging local release artifacts for ${target.platform}-${target.arch}...\n`,
        );

        run('pnpm', getPackagingArgs(target), {
            env,
            stdio: 'inherit',
        });

        pruneUpdaterMetadataForLocalParity(target);
        assertReleaseArtifactsExist(target);
        validateUpdaterMetadata(target);
        verifyLocalPackageArtifacts(target);

        process.stdout.write(
            `Local release packaging verification passed for ${target.platform}-${target.arch}.\n`,
        );
    }
}

main();
