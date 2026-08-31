import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {
    assertCleanTrackedWebDeploySource,
    getTrackedWebDeploySourcePaths,
    isExcludedWebDeploySourceDirectoryName,
    isExcludedWebDeploySourceFileName,
} from './check-web-deploy-source.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedDeployTargets = new Set([
    'landing',
    'viewer',
]);
const landingBuildCommand = [
    'pnpm --dir landing run build',
    'node scripts/deployVercelPrivate.mjs --promote-landing-output',
].join(' && ');

// The copy filter and the `check-web-deploy-source.mjs` walker share one entry
// predicate, so what this deploy uploads is what that check measured: local-only
// artifacts (in any ASCII case, at any depth), env files that are not templates,
// and the deploy-specific build files are all excluded from both.
export function shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget = 'viewer') {
    const relativePath = path.relative(projectRoot, sourcePath);

    if (relativePath === '') {
        return true;
    }

    const segments = relativePath.split(/[\\/]+/u);

    if (segments.some(segment => (
        isExcludedWebDeploySourceDirectoryName(segment)
        && !(deployTarget === 'landing' && segment === 'landing')
    ))) {
        return false;
    }

    return !isExcludedWebDeploySourceFileName(path.basename(sourcePath));
}

function shouldKeepVercelIgnoreLine(line, sourceRoot) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('!')) {
        return true;
    }

    const normalizedLine = trimmedLine.replace(/^\/+/, '');
    const [firstSegment] = normalizedLine.split(/[\\/]+/u);

    return !firstSegment || existsSync(path.join(sourceRoot, firstSegment));
}

function sanitizeVercelIgnore(sourceRoot, deployTarget) {
    const vercelIgnorePath = path.join(sourceRoot, '.vercelignore');

    if (!existsSync(vercelIgnorePath)) {
        return;
    }

    const content = readFileSync(vercelIgnorePath, 'utf8');
    const lines = content.split(/\r?\n/u);
    const filteredLines = lines.filter((line) => {
        const normalizedLine = line.trim().replace(/^\/+|\/+$/gu, '');

        if (deployTarget === 'landing' && normalizedLine === 'landing') {
            return false;
        }

        return shouldKeepVercelIgnoreLine(line, sourceRoot);
    });

    writeFileSync(vercelIgnorePath, filteredLines.join('\n'), 'utf8');
}

function sanitizePnpmWorkspace(sourceRoot) {
    const workspacePath = path.join(sourceRoot, 'pnpm-workspace.yaml');

    if (!existsSync(workspacePath)) {
        return;
    }

    const content = readFileSync(workspacePath, 'utf8');
    const lines = content.split(/\r?\n/u);
    let isPackagesSection = false;
    const filteredLines = lines.filter((line) => {
        if (/^packages:\s*(?:#.*)?$/u.test(line)) {
            isPackagesSection = true;
            return true;
        }
        if (/^[^\s#][^:]*:/u.test(line)) {
            isPackagesSection = false;
        }
        if (!isPackagesSection) {
            return true;
        }

        const packageEntry = line.match(/^\s*-\s*['"]([^'"]+)['"]\s*$/u)?.[1];

        if (!packageEntry || /[*?[{]/u.test(packageEntry)) {
            return true;
        }

        return existsSync(path.join(sourceRoot, packageEntry));
    });

    writeFileSync(workspacePath, filteredLines.join('\n'), 'utf8');
}

function configureLandingBuild(sourceRoot) {
    const packageJsonPath = path.join(sourceRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

    packageJson.scripts = {
        ...packageJson.scripts,
        build: landingBuildCommand,
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

function copyTrackedDeploySource(projectRoot, sourceRoot, deployTarget) {
    for (const relativePath of getTrackedWebDeploySourcePaths(projectRoot)) {
        const sourcePath = path.join(projectRoot, relativePath);
        if (!shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget)) {
            continue;
        }

        const destinationPath = path.join(sourceRoot, relativePath);
        const sourceStat = lstatSync(sourcePath);
        if (sourceStat.isSymbolicLink()) {
            throw new Error(`Tracked web deploy source contains a symbolic link: ${relativePath}`);
        }
        if (!sourceStat.isFile()) {
            throw new Error(`Tracked web deploy source is not a regular file: ${relativePath}`);
        }
        mkdirSync(path.dirname(destinationPath), {recursive: true});
        cpSync(sourcePath, destinationPath, {force: true});
    }
}

export function promoteLandingVercelOutput(projectRoot = defaultProjectRoot) {
    const landingOutputRoot = path.join(projectRoot, 'landing', '.vercel', 'output');
    const landingConfigPath = path.join(landingOutputRoot, 'config.json');
    const rootOutputRoot = path.join(projectRoot, '.vercel', 'output');

    if (!existsSync(landingConfigPath)) {
        throw new Error(`Landing build did not produce ${landingConfigPath}.`);
    }

    rmSync(rootOutputRoot, {
        force: true,
        recursive: true,
    });
    mkdirSync(path.dirname(rootOutputRoot), {recursive: true});
    cpSync(landingOutputRoot, rootOutputRoot, {
        force: true,
        recursive: true,
        verbatimSymlinks: true,
    });
}

export function preparePrivateDeploySource({
    deployTarget = 'viewer',
    projectRoot = defaultProjectRoot,
} = {}) {
    if (!supportedDeployTargets.has(deployTarget)) {
        throw new Error(`Unsupported deploy target: ${deployTarget}`);
    }

    const projectLinkRoot = deployTarget === 'landing'
        ? path.join(projectRoot, 'landing')
        : projectRoot;
    const projectJson = path.join(projectLinkRoot, '.vercel', 'project.json');

    if (!existsSync(projectJson)) {
        throw new Error(`Missing ${projectJson}. Run \`vercel link\` in this project first.`);
    }

    assertCleanTrackedWebDeploySource(projectRoot);

    const scratchRoot = mkdtempSync(path.join(tmpdir(), 'evb-vercel-private-'));
    const sourceRoot = path.join(scratchRoot, 'source');

    mkdirSync(sourceRoot, {recursive: true});
    copyTrackedDeploySource(projectRoot, sourceRoot, deployTarget);
    mkdirSync(path.join(sourceRoot, '.vercel'), {recursive: true});
    cpSync(projectJson, path.join(sourceRoot, '.vercel', 'project.json'));
    sanitizePnpmWorkspace(sourceRoot);
    sanitizeVercelIgnore(sourceRoot, deployTarget);
    if (deployTarget === 'landing') {
        configureLandingBuild(sourceRoot);
    }

    return {
        cleanup: () => rmSync(scratchRoot, {
            force: true,
            recursive: true,
        }),
        scratchRoot,
        sourceRoot,
    };
}

export function parsePrivateDeployOptions(rawArgs = []) {
    const targetArgs = rawArgs.filter(arg => arg.startsWith('--target='));

    if (targetArgs.length > 1) {
        throw new Error(`Expected at most one deploy target, received: ${targetArgs.join(', ')}`);
    }

    const deployTarget = targetArgs[0]?.slice('--target='.length) || 'viewer';

    if (!supportedDeployTargets.has(deployTarget)) {
        throw new Error(`Unsupported deploy target: ${deployTarget}`);
    }

    return {
        deployArgs: rawArgs.filter(arg => !arg.startsWith('--target=')),
        deployTarget,
    };
}

export function buildPrivateDeployArgs(sourceRoot, rawArgs = []) {
    const deployArgs = [...rawArgs];
    const hasArchive = deployArgs.some(arg => arg === '--archive' || arg.startsWith('--archive='));
    const hasYes = deployArgs.includes('--yes') || deployArgs.includes('-y');

    return [
        'deploy',
        sourceRoot,
        ...(hasYes ? [] : ['--yes']),
        ...(hasArchive ? [] : ['--archive=tgz']),
        ...deployArgs,
    ];
}

export function extractVercelDeploymentUrl(output) {
    return output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app(?:\/[^\s"'<>]*)?/iu)?.[0] ?? null;
}

export function buildVercelRollbackArgs(deploymentUrl) {
    if (!deploymentUrl) {
        throw new Error('A deployment URL is required before a production rollback can run.');
    }
    return [
        'rollback',
        deploymentUrl,
        '--yes',
    ];
}

function parseHttpsAcceptanceUrls(rawValue) {
    return rawValue
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => {
            const url = new URL(value);
            if (url.protocol !== 'https:') {
                throw new Error(`Deploy acceptance URL must use HTTPS: ${value}`);
            }
            return url.href;
        });
}

async function runDeployAcceptanceChecks({
    deploymentUrl,
    deployTarget,
    env,
    fetchImpl,
    sourceRoot,
    spawnSyncImpl,
}) {
    const configuredUrls = env.EVB_DEPLOY_ACCEPTANCE_URL?.trim()
        ? parseHttpsAcceptanceUrls(env.EVB_DEPLOY_ACCEPTANCE_URL)
        : [deploymentUrl];
    if (configuredUrls.length === 0) {
        throw new Error('Production deploy acceptance requires EVB_DEPLOY_ACCEPTANCE_URL or a Vercel deployment URL.');
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('Production deploy acceptance requires a fetch implementation.');
    }

    for (const url of configuredUrls) {
        const response = await fetchImpl(url, {
            headers: {accept: 'text/html,application/json'},
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            throw new Error(`Deploy acceptance URL ${url} responded with HTTP ${response.status}.`);
        }
    }

    const acceptanceCommand = env.EVB_DEPLOY_ACCEPTANCE_COMMAND?.trim();
    if (acceptanceCommand) {
        const result = spawnSyncImpl(acceptanceCommand, [], {
            cwd: sourceRoot,
            env: {
                ...env,
                EVB_DEPLOYMENT_URL: deploymentUrl,
                EVB_DEPLOY_TARGET: deployTarget,
            },
            shell: true,
            stdio: 'inherit',
        });
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            throw new Error(`Deploy acceptance command exited with ${result.status ?? 1}.`);
        }
    }
}

export function quoteWindowsShellArg(arg) {
    // spawnSync with shell:true on Windows concatenates args into a cmd.exe
    // command line. Whitespace splits an unquoted arg, but so do cmd's own
    // metacharacters (& | < > ( ) ^): a scratch path under an account name like
    // "A&B" (C:\Users\A&B\AppData\Local\Temp\...) has no spaces yet the bare &
    // makes cmd run the tail as a separate command. Wrapping every argument in
    // double quotes makes all of those literal, and the target program's own
    // argv parser strips the outer quotes. The one residual cmd cannot escape is
    // % (env expansion runs even inside quotes); it is not reachable from the
    // paths and deploy flags built here.
    return `"${arg.replace(/"/g, '\\"')}"`;
}

export async function runPrivateVercelDeploy({
    command = process.env.VERCEL_CLI || 'vercel',
    projectRoot = defaultProjectRoot,
    rawArgs = process.argv.slice(2),
    env = process.env,
    fetchImpl = globalThis.fetch,
    spawnSyncImpl = spawnSync,
} = {}) {
    const {
        deployArgs,
        deployTarget,
    } = parsePrivateDeployOptions(rawArgs);
    const prepared = preparePrivateDeploySource({
        deployTarget,
        projectRoot,
    });
    const commandArgs = buildPrivateDeployArgs(prepared.sourceRoot, deployArgs);
    const isProduction = deployArgs.includes('--prod');

    try {
        const useShell = process.platform === 'win32';
        const spawnCommand = useShell ? quoteWindowsShellArg(command) : command;
        const spawnArgs = useShell ? commandArgs.map(quoteWindowsShellArg) : commandArgs;
        console.log(`> ${command} ${commandArgs.join(' ')}`);
        const result = spawnSyncImpl(spawnCommand, spawnArgs, {
            cwd: prepared.sourceRoot,
            env,
            encoding: 'utf8',
            shell: useShell,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        if (result.error) {
            throw result.error;
        }

        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        if (result.stdout) {
            process.stdout.write(result.stdout);
        }
        if (result.stderr) {
            process.stderr.write(result.stderr);
        }
        if ((result.status ?? 1) !== 0) {
            return result.status ?? 1;
        }
        if (!isProduction) {
            return 0;
        }

        const deploymentUrl = extractVercelDeploymentUrl(output);
        if (!deploymentUrl) {
            throw new Error('Production Vercel deploy did not report a deployment URL; refusing an unverified alias.');
        }

        try {
            await runDeployAcceptanceChecks({
                deploymentUrl,
                deployTarget,
                env,
                fetchImpl,
                sourceRoot: prepared.sourceRoot,
                spawnSyncImpl,
            });
        } catch (error) {
            let rollbackError;
            try {
                const rollbackArgs = buildVercelRollbackArgs(deploymentUrl);
                const rollbackUseShell = process.platform === 'win32';
                const rollbackCommand = rollbackUseShell ? quoteWindowsShellArg(command) : command;
                const rollbackSpawnArgs = rollbackUseShell
                    ? rollbackArgs.map(quoteWindowsShellArg)
                    : rollbackArgs;
                const rollbackResult = spawnSyncImpl(rollbackCommand, rollbackSpawnArgs, {
                    cwd: prepared.sourceRoot,
                    env,
                    shell: rollbackUseShell,
                    stdio: 'inherit',
                });
                if (rollbackResult.error) {
                    throw rollbackResult.error;
                }
                if ((rollbackResult.status ?? 1) !== 0) {
                    throw new Error(`Vercel rollback exited with ${rollbackResult.status ?? 1}.`);
                }
            } catch (rollbackFailure) {
                rollbackError = rollbackFailure;
            }
            const acceptanceMessage = error instanceof Error ? error.message : String(error);
            const rollbackMessage = rollbackError
                ? ` Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
                : ' The failed deployment was rolled back.';
            throw new Error(`Production deploy acceptance failed: ${acceptanceMessage}.${rollbackMessage}`, {cause: error});
        }

        return 0;
    } finally {
        prepared.cleanup();
    }
}

const isMain = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
    if (process.argv.includes('--promote-landing-output')) {
        promoteLandingVercelOutput();
    } else {
        process.exitCode = await runPrivateVercelDeploy();
    }
}
