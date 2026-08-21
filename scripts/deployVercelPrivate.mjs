import {
    cpSync,
    existsSync,
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

    const scratchRoot = mkdtempSync(path.join(tmpdir(), 'evb-vercel-private-'));
    const sourceRoot = path.join(scratchRoot, 'source');

    cpSync(projectRoot, sourceRoot, {
        filter: sourcePath => shouldCopyPrivateDeployPath(sourcePath, projectRoot, deployTarget),
        force: true,
        recursive: true,
        verbatimSymlinks: true,
    });
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

export function runPrivateVercelDeploy({
    command = process.env.VERCEL_CLI || 'vercel',
    projectRoot = defaultProjectRoot,
    rawArgs = process.argv.slice(2),
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

    try {
        const useShell = process.platform === 'win32';
        const spawnCommand = useShell ? quoteWindowsShellArg(command) : command;
        const spawnArgs = useShell ? commandArgs.map(quoteWindowsShellArg) : commandArgs;
        console.log(`> ${command} ${commandArgs.join(' ')}`);
        const result = spawnSync(spawnCommand, spawnArgs, {
            cwd: prepared.sourceRoot,
            env: process.env,
            shell: useShell,
            stdio: 'inherit',
        });

        if (result.error) {
            throw result.error;
        }

        return result.status ?? 1;
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
        process.exitCode = runPrivateVercelDeploy();
    }
}
