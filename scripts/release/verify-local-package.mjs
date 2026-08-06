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
    RELEASE_BUILD_RECEIPT_ENV_VAR,
    validateReleaseBuildReceipt,
} from './build-receipt.mjs';
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

function packagedMacExecutablePath(target) {
    const candidates = [
        `${RELEASE_DIR}/mac-${target.arch}/EVB Viewer.app`,
        `${RELEASE_DIR}/mac/EVB Viewer.app`,
    ].map(candidate => resolve(process.cwd(), candidate));
    const appDir = candidates.find(candidate => existsSync(candidate));
    if (!appDir) {
        throw new Error(`Packaged app not found under: ${candidates.join(', ')}`);
    }
    return path.join(appDir, 'Contents', 'MacOS', 'EVB Viewer');
}

function runPackagedScanCleanupVerifier(target) {
    if (target.platform !== 'mac') {
        return;
    }
    // The strongest packaged verifier drives the packaged app through a real
    // scan-cleanup conversion. Its source PDF is machine-local, so the gate
    // follows the nightly-regress convention: a .devkit fixture config makes
    // it REQUIRED, and its absence is an explicit skip line, never silence.
    const fixtureConfigPath = resolve(process.cwd(), '.devkit/scan-cleanup-release-fixture.json');
    if (!existsSync(fixtureConfigPath)) {
        process.stdout.write(
            'SKIPPED packaged scan-cleanup verification: no fixture config at '
            + '.devkit/scan-cleanup-release-fixture.json (create {"source": <pdf>, '
            + '"expectedPages": <n>} to make this a required local release gate).\n',
        );
        return;
    }
    const fixture = JSON.parse(readFileSync(fixtureConfigPath, 'utf8'));
    run('pnpm', [
        'exec',
        'tsx',
        'scripts/release/verifyPackagedScanCleanup.ts',
        '--executable',
        packagedMacExecutablePath(target),
        '--source',
        fixture.source,
        '--expected-pages',
        String(fixture.expectedPages),
        '--artifact-dir',
        resolve(process.cwd(), '.devkit/release-verify/scan-cleanup'),
    ], { stdio: 'inherit' });
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
        runPackagedScanCleanupVerifier(target);
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
    const releaseCiEnv = getReleaseCiEnv(process.env);
    const buildCommand = getLocalReleaseBuildCommand();
    const receiptPath = releaseCiEnv[RELEASE_BUILD_RECEIPT_ENV_VAR];
    const receiptResult = receiptPath
        ? validateReleaseBuildReceipt(receiptPath, {env: releaseCiEnv})
        : {
            reason: 'not-requested',
            valid: false,
        };
    if (receiptResult.valid) {
        process.stdout.write(
            `Reusing strict build proven fresh by ${receiptPath}.\n`,
        );
    } else {
        if (receiptPath) {
            process.stdout.write(
                `Strict-build receipt is not reusable (${receiptResult.reason}); rebuilding.\n`,
            );
        }
        run(buildCommand.command, buildCommand.args, {
            env: releaseCiEnv,
            stdio: 'inherit',
        });
    }

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
