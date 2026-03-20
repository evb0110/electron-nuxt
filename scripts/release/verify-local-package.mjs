import {
    existsSync,
    readFileSync,
    readdirSync,
    rmSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import { run } from './shared.mjs';

function hasDeveloperIdSigningCredentials() {
    return Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
}

function getLocalReleaseTarget() {
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

    const arch = process.arch;
    const expectsUpdaterMetadata = (
        (platform === 'mac' && arch === 'arm64')
        || (platform === 'win' && arch === 'x64')
    );

    return {
        arch,
        expectsUpdaterMetadata,
        platform,
    };
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
    const distDir = resolve(process.cwd(), 'dist');
    if (!existsSync(distDir)) {
        throw new Error('dist/ was not created by electron-builder');
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
            throw new Error(`Missing packaged artifact matching ${pattern} in dist/`);
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
    if (!target.expectsUpdaterMetadata) {
        return;
    }

    const distDir = resolve(process.cwd(), 'dist');
    const ymlFiles = readdirSync(distDir)
        .filter(name => /^latest.*\.yml$/.test(name))
        .map(name => join(distDir, name));

    if (ymlFiles.length === 0) {
        throw new Error('No latest*.yml files found in dist/');
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

function main() {
    // Local packaging verification is intentionally limited to the current host
    // platform. Cross-platform behavior still needs CI plus host-independent
    // tests for any branching logic in launcher or packaging code.
    const target = getLocalReleaseTarget();
    const distDir = resolve(process.cwd(), 'dist');

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

    assertReleaseArtifactsExist(target);
    validateUpdaterMetadata(target);

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

    process.stdout.write(
        `Local release packaging verification passed for ${target.platform}-${target.arch}.\n`,
    );
}

main();
