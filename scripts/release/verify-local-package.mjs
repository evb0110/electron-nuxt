import {
    existsSync,
    readFileSync,
    readdirSync,
    rmSync,
    unlinkSync,
} from 'node:fs';
import path, {
    join,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './shared.mjs';
import {
    getReleaseCiEnv,
    expectsUpdaterMetadata,
    getLocalReleaseTargets,
    getRequiredArtifactPatterns,
    parseUpdaterMetadataFileUrls,
    parseUpdaterMetadataPath,
    shouldVerifyPackagedStartup,
} from './policy.mjs';
import { notarizeMacDmgArtifacts } from './notarize-macos-dmgs.mjs';

const RELEASE_DIR = 'release';

export function getLocalReleaseBuildCommand() {
    return {
        args: [
            'run',
            'build:strict',
        ],
        command: 'pnpm',
    };
}

export function getPackagingArgs(target, env = process.env) {
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

    if (target.platform === 'mac' && !expectsUpdaterMetadata(target, env)) {
        // Unsigned local mac verification intentionally drops updater metadata,
        // so it only needs the manual-install DMG artifact.
        return [
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'dmg',
            `--${target.arch}`,
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

function assertReleaseArtifactsExist(target, env = process.env) {
    const distDir = resolve(process.cwd(), RELEASE_DIR);
    if (!existsSync(distDir)) {
        throw new Error(`${RELEASE_DIR}/ was not created by electron-builder`);
    }

    const files = readdirSync(distDir);
    for (const pattern of getRequiredArtifactPatterns(target, env)) {
        const matched = files.some(file => pattern.test(file));
        if (!matched) {
            throw new Error(`Missing packaged artifact matching ${pattern} in ${RELEASE_DIR}/`);
        }
    }
}

function validateUpdaterMetadata(target, env = process.env) {
    const shouldExist = expectsUpdaterMetadata(target, env);
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
        const metadataText = readFileSync(ymlPath, 'utf8');
        const referencedArtifacts = new Set([
            parseUpdaterMetadataPath(ymlPath, metadataText),
            ...parseUpdaterMetadataFileUrls(ymlPath, metadataText),
        ]);

        for (const relPath of referencedArtifacts) {
            const artifactPath = join(distDir, relPath);
            if (!existsSync(artifactPath)) {
                throw new Error(`Updater metadata mismatch in ${ymlPath} -> ${relPath} not found`);
            }
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
        run('node', [ 'scripts/release/assert-packaged-app-contents.mjs' ], { stdio: 'inherit' });
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
    run('node', [ 'scripts/release/assert-packaged-app-contents.mjs' ], { stdio: 'inherit' });

    if (shouldVerifyPackagedStartup(target)) {
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

export function getGeneratedNativeResourceCommands(target) {
    void target;
    return [];
}

export function prepareGeneratedNativeResources(target, env, runCommand = run) {
    const commands = getGeneratedNativeResourceCommands(target);
    if (commands.length === 0) {
        return;
    }

    process.stdout.write(
        `Bundling generated native resources for ${target.platform}-${target.arch}...\n`,
    );
    for (const command of commands) {
        runCommand(command.command, command.args, {
            env,
            stdio: 'inherit',
        });
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
    const releaseCiEnv = getReleaseCiEnv(process.env);
    const buildCommand = getLocalReleaseBuildCommand();

    run(buildCommand.command, buildCommand.args, {
        env: releaseCiEnv,
        stdio: 'inherit',
    });

    for (const target of targets) {
        rmSync(distDir, {
            force: true,
            recursive: true,
        });

        const env = { ...releaseCiEnv };
        if (target.platform === 'linux') {
            env.USE_SYSTEM_FPM = 'true';
        }
        process.stdout.write(
            `Packaging local release artifacts for ${target.platform}-${target.arch}...\n`,
        );

        prepareGeneratedNativeResources(target, env);

        run('pnpm', getPackagingArgs(target, env), {
            env,
            stdio: 'inherit',
        });

        if (target.platform === 'mac') {
            notarizeMacDmgArtifacts({
                artifactsDir: distDir,
                env,
            });
        }

        pruneUpdaterMetadataForLocalParity(target);
        assertReleaseArtifactsExist(target, env);
        validateUpdaterMetadata(target, env);
        verifyLocalPackageArtifacts(target);

        process.stdout.write(
            `Local release packaging verification passed for ${target.platform}-${target.arch}.\n`,
        );
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main();
}
