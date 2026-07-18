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
    WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES,
    WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES,
} from './check-web-deploy-source.mjs';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectoryNames = new Set(WEB_DEPLOY_SOURCE_EXCLUDED_DIRECTORY_NAMES);
const excludedFileNames = new Set(WEB_DEPLOY_SOURCE_EXCLUDED_FILE_NAMES);

function isExcludedEnvFileName(fileName) {
    if (fileName === '.env' || fileName.startsWith('.env.')) {
        return !/\.(example|sample|template)$/iu.test(fileName);
    }

    return false;
}

export function shouldCopyPrivateDeployPath(sourcePath, projectRoot) {
    const relativePath = path.relative(projectRoot, sourcePath);

    if (relativePath === '') {
        return true;
    }

    const segments = relativePath.split(/[\\/]+/u);

    if (segments.some(segment => excludedDirectoryNames.has(segment))) {
        return false;
    }

    const fileName = path.basename(sourcePath);

    return !excludedFileNames.has(fileName) && !isExcludedEnvFileName(fileName);
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

function sanitizeVercelIgnore(sourceRoot) {
    const vercelIgnorePath = path.join(sourceRoot, '.vercelignore');

    if (!existsSync(vercelIgnorePath)) {
        return;
    }

    const content = readFileSync(vercelIgnorePath, 'utf8');
    const lines = content.split(/\r?\n/u);
    const filteredLines = lines.filter(line => shouldKeepVercelIgnoreLine(line, sourceRoot));

    writeFileSync(vercelIgnorePath, filteredLines.join('\n'), 'utf8');
}

export function preparePrivateDeploySource({projectRoot = defaultProjectRoot} = {}) {
    const projectJson = path.join(projectRoot, '.vercel', 'project.json');

    if (!existsSync(projectJson)) {
        throw new Error(`Missing ${projectJson}. Run \`vercel link\` in this project first.`);
    }

    const scratchRoot = mkdtempSync(path.join(tmpdir(), 'evb-vercel-private-'));
    const sourceRoot = path.join(scratchRoot, 'source');

    cpSync(projectRoot, sourceRoot, {
        filter: sourcePath => shouldCopyPrivateDeployPath(sourcePath, projectRoot),
        force: true,
        recursive: true,
        verbatimSymlinks: true,
    });
    mkdirSync(path.join(sourceRoot, '.vercel'), {recursive: true});
    cpSync(projectJson, path.join(sourceRoot, '.vercel', 'project.json'));
    sanitizeVercelIgnore(sourceRoot);

    return {
        cleanup: () => rmSync(scratchRoot, {
            force: true,
            recursive: true,
        }),
        scratchRoot,
        sourceRoot,
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

export function runPrivateVercelDeploy({
    command = process.env.VERCEL_CLI || 'vercel',
    projectRoot = defaultProjectRoot,
    rawArgs = process.argv.slice(2),
} = {}) {
    const prepared = preparePrivateDeploySource({projectRoot});
    const commandArgs = buildPrivateDeployArgs(prepared.sourceRoot, rawArgs);

    try {
        console.log(`> ${command} ${commandArgs.join(' ')}`);
        const result = spawnSync(command, commandArgs, {
            cwd: prepared.sourceRoot,
            env: process.env,
            shell: process.platform === 'win32',
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
    process.exitCode = runPrivateVercelDeploy();
}
