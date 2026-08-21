#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    constants as fsConstants,
    createWriteStream,
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import {
    mkdir,
    open,
    readFile,
    readdir,
    rm,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getValidationImpactPolicy } from './release/policy.mjs';
import { matchesChangedAreaPattern } from './ci/classify-changed-areas.mjs';
import { withNodeHeap } from './typecheckNodeEnv.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitProjects = [
    'unit-core',
    'unit-app',
    'unit-electron',
    'unit-scripts',
    'unit-policy',
    'unit-static-architecture',
];
const allTs7Projects = [
    'electron/tsconfig.json',
    'tests/tsconfig.json',
    'tsconfig.scripts.json',
    'server/tsconfig.json',
];
const heavyGateDefaultCapacity = 2;
const heavyGateDefaultWaitMs = 30 * 60_000;
const lintableSourcePattern = /\.(?:[cm]?[jt]sx?|vue)$/u;
const validationTiers = new Set([
    'iteration',
    'acceptance',
    'integration',
    'nightly',
]);
function normalizePath(filePath) {
    return filePath.split(path.sep).join('/').replace(/^\.\//u, '');
}
function unique(values) {
    return [...new Set(values)];
}
function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function readArg(argv, name) {
    const prefix = `--${name}=`;
    return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}
function readArgs(argv, name) {
    const prefix = `--${name}=`;
    return argv
        .filter(argument => argument.startsWith(prefix))
        .map(argument => argument.slice(prefix.length))
        .filter(Boolean);
}
function runCapture(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            ...options,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr?.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', error => resolve({
            error,
            status: null,
            stderr,
            stdout,
        }));
        child.on('close', status => resolve({
            error: null,
            status,
            stderr,
            stdout,
        }));
    });
}
async function gitOutput(args) {
    const result = await runCapture('git', args);
    if (result.error || result.status !== 0) {
        return null;
    }
    return result.stdout.trim();
}
function splitNullOutput(output) {
    return output?.split('\0').filter(Boolean).map(normalizePath) ?? [];
}
export async function collectValidationChanges({
    base,
    explicitFiles = [],
} = {}) {
    if (explicitFiles.length > 0) {
        return {
            files: unique(explicitFiles.map(normalizePath)),
            known: true,
            reason: 'explicit-files',
        };
    }
    const resolvedBase = base
        ?? process.env.EVB_GATE_BASE
        ?? await gitOutput([
            'merge-base',
            'HEAD',
            'origin/main',
        ]);
    const workingOutputs = await Promise.all([
        gitOutput([
            'diff',
            '--name-only',
            '--no-renames',
            '--diff-filter=ACDMR',
            '-z',
        ]),
        gitOutput([
            'diff',
            '--cached',
            '--name-only',
            '--no-renames',
            '--diff-filter=ACDMR',
            '-z',
        ]),
        gitOutput([
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
        ]),
    ]);
    if (!resolvedBase || workingOutputs.some(output => output === null)) {
        return {
            files: [],
            known: false,
            reason: 'git-change-detection-failed',
        };
    }
    const committedOutput = await gitOutput([
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=ACDMR',
        '-z',
        `${resolvedBase}...HEAD`,
    ]);
    if (committedOutput === null) {
        return {
            files: [],
            known: false,
            reason: 'git-base-diff-failed',
        };
    }
    return {
        base: resolvedBase,
        files: unique([
            ...splitNullOutput(committedOutput),
            ...workingOutputs.flatMap(splitNullOutput),
        ]).sort(),
        known: true,
        reason: 'git',
    };
}
export function classifyValidationImpacts(
    files,
    policy = getValidationImpactPolicy(),
) {
    const normalizedFiles = unique(files.map(normalizePath).filter(Boolean));
    const impacts = Object.fromEntries(Object.entries(policy).map(([
        impact,
        definition,
    ]) => [
        impact,
        normalizedFiles.some(file => definition.paths.some(pattern => (
            matchesChangedAreaPattern(file, pattern)
        ))),
    ]));
    const unmatchedFiles = normalizedFiles.filter(file => !Object.values(policy).some(definition => (
        definition.paths.some(pattern => matchesChangedAreaPattern(file, pattern))
    )));
    return {
        full: unmatchedFiles.length > 0,
        impacts,
        unmatchedFiles,
    };
}
function selectedTypecheckProjects(files, classification) {
    if (classification.full || classification.impacts.policy) {
        return {
            nuxt: true,
            projects: [...allTs7Projects],
            workspacePackages: true,
        };
    }
    const projects = [];
    if (classification.impacts.electron) {
        projects.push('electron/tsconfig.json');
    }
    if (classification.impacts.tests) {
        projects.push('tests/tsconfig.json');
    }
    if (classification.impacts.scripts || classification.impacts.build || classification.impacts.native) {
        projects.push('tsconfig.scripts.json');
    }
    if (classification.impacts.server) {
        projects.push('server/tsconfig.json');
    }
    if (classification.impacts.packages) {
        projects.push(...allTs7Projects);
    }

    return {
        nuxt: classification.impacts.app || classification.impacts.packages,
        projects: unique(projects),
        workspacePackages: classification.impacts.packages,
    };
}
function selectedUnitProjects(files, classification) {
    if (classification.full || classification.impacts.policy) {
        return [...unitProjects];
    }
    const projects = [];
    if (classification.impacts.app) {
        projects.push('unit-app', 'unit-static-architecture');
    }
    if (classification.impacts.electron) {
        projects.push('unit-electron');
    }
    if (classification.impacts.packages || classification.impacts.server) {
        projects.push('unit-core');
    }
    if (classification.impacts.packages) {
        projects.push(...unitProjects);
    }
    if (classification.impacts.scripts || classification.impacts.build || classification.impacts.native) {
        projects.push('unit-scripts', 'unit-static-architecture');
    }
    for (const file of files) {
        if (file.startsWith('tests/e2e/electron/quarantine/')) {
            projects.push('unit-static-architecture');
        } else if (file.startsWith('tests/unit/app/')) {
            projects.push('unit-app', 'unit-static-architecture');
        } else if (file.startsWith('tests/unit/architecture/')) {
            projects.push('unit-static-architecture');
        } else if (file.startsWith('tests/unit/electron/') || file.startsWith('tests/unit/e2e/')) {
            projects.push('unit-electron');
        } else if (file.startsWith('tests/unit/scripts/')) {
            projects.push('unit-scripts', 'unit-policy');
        } else if (file.startsWith('tests/unit/')) {
            projects.push('unit-core');
        }
    }
    return unique(projects);
}
function stage(id, command, args, options = {}) {
    return {
        args,
        command,
        heavyWeight: 0,
        ...options,
        id,
    };
}
function pnpmRunStage(id, scriptName, options = {}) {
    return stage(id, 'pnpm', [
        'run',
        scriptName,
    ], options);
}
function nodeStage(id, scriptName, args = [], options = {}) {
    return stage(id, 'node', [
        scriptName,
        ...args,
    ], options);
}
function vitestStage(id, projects, extraArgs = [], options = {}) {
    return stage(id, 'pnpm', [
        'exec',
        'vitest',
        'run',
        ...projects.flatMap(project => [
            '--project',
            project,
        ]),
        ...extraArgs,
    ], options);
}
function vitestRelatedStage(id, projects, files, options = {}) {
    return stage(id, 'pnpm', [
        'exec',
        'vitest',
        'related',
        ...files,
        ...projects.flatMap(project => [
            '--project',
            project,
        ]),
        '--passWithNoTests',
    ], options);
}
function affectedPlan(tier, files, classification) {
    const stages = [];
    const typecheck = selectedTypecheckProjects(files, classification);
    const selectedUnits = selectedUnitProjects(files, classification);
    stages.push(nodeStage('lint.affected', 'scripts/validation-gates.mjs', [
        'lint',
        '--changed',
        ...files.map(file => `--file=${file}`),
    ]));
    if (typecheck.nuxt) {
        stages.push(nodeStage('typecheck.nuxt', 'scripts/run-nuxt-typecheck.mjs'));
    }
    if (typecheck.projects.length > 0 || typecheck.workspacePackages) {
        stages.push(stage('typecheck.ts7', 'node', [
            typecheck.workspacePackages
                ? 'scripts/run-workspace-package-typecheck.mjs'
                : 'scripts/run-ts7-typecheck.mjs',
            ...typecheck.projects.flatMap(project => [
                '-p',
                project,
            ]),
        ]));
    }
    if (tier === 'iteration') {
        const relatedFiles = files.filter(file => /\.(?:[cm]?[jt]sx?|vue)$/u.test(file));
        if (relatedFiles.length > 0 && selectedUnits.length > 0) {
            stages.push(vitestRelatedStage(
                'test.unit.related',
                selectedUnits,
                relatedFiles,
                {heavyWeight: 1},
            ));
        }
        return stages;
    }

    if (selectedUnits.length > 0) {
        stages.push(vitestStage('test.unit.affected-projects', selectedUnits, [], {heavyWeight: 1}));
    }
    stages.push(pnpmRunStage('fallow.dead-code', 'fallow'));
    if (classification.impacts.webDeploy) {
        stages.push(nodeStage('static.web-deploy-source', 'scripts/check-web-deploy-source.mjs'));
    }
    if (classification.impacts.landing) {
        stages.push(stage('landing.typecheck', 'pnpm', [
            '--dir',
            'landing',
            'run',
            'typecheck',
        ]));
    }
    if (classification.impacts.native) {
        stages.push(
            pnpmRunStage('native.lint', 'lint:rust', {heavyWeight: 1}),
            pnpmRunStage('native.test', 'test:rust', {heavyWeight: 1}),
            pnpmRunStage('native.resource-matrix', 'check:resources:matrix'),
        );
    }
    if (classification.impacts.native || classification.impacts.build) {
        stages.push(pnpmRunStage('build.strict', 'build:strict', {heavyWeight: 1}));
    }
    if (classification.impacts.app || classification.impacts.electron) {
        stages.push(pnpmRunStage(
            'electron.blocking-smoke',
            'test:e2e:electron:blocking-smoke:headless',
            {heavyWeight: 2},
        ));
    }
    return stages;
}
export function getValidationPlan({
    changes,
    classification = classifyValidationImpacts(changes.files),
    tier,
}) {
    if (!validationTiers.has(tier)) {
        throw new Error(`Unknown validation tier "${tier}".`);
    }
    const mustRunFull = !changes.known
        || classification.full
        || classification.impacts.policy
        || (changes.files.length === 0 && tier !== 'iteration');

    if (tier === 'iteration' && changes.known && changes.files.length === 0) {
        return [];
    }
    if ((tier === 'iteration' || tier === 'acceptance') && !mustRunFull) {
        return affectedPlan(tier, changes.files, classification);
    }
    if (tier === 'iteration') {
        return [
            pnpmRunStage('lint.full', 'lint'),
            pnpmRunStage('typecheck.full', 'typecheck'),
            pnpmRunStage('test.unit.full', 'test:unit', {heavyWeight: 1}),
        ];
    }

    const fullStages = [
        pnpmRunStage('lint.full', tier === 'acceptance' ? 'lint' : 'lint:clean'),
        pnpmRunStage('typecheck.full', tier === 'acceptance' ? 'typecheck' : 'typecheck:clean'),
        ...(tier === 'nightly'
            ? []
            : [pnpmRunStage('test.unit.full', 'test:unit', {heavyWeight: 1})]),
        pnpmRunStage('fallow.dead-code', 'fallow'),
        pnpmRunStage('build.strict', 'build:strict', {heavyWeight: 1}),
    ];
    if (tier === 'iteration' || tier === 'acceptance' || tier === 'integration') {
        if (tier === 'acceptance') {
            fullStages.push(pnpmRunStage(
                'electron.blocking-smoke',
                'test:e2e:electron:blocking-smoke:headless',
                {heavyWeight: 2},
            ));
        }
        if (
            tier === 'integration'
            && (
                !changes.known
                || classification.full
                || classification.impacts.policy
                || classification.impacts.app
                || classification.impacts.electron
            )
        ) {
            fullStages.push(pnpmRunStage(
                'electron.regression',
                'test:e2e:electron:headless',
                {heavyWeight: 2},
            ));
        }
        return fullStages;
    }

    return [
        ...fullStages,
        pnpmRunStage('static.platform-report', 'check:static:reports'),
        pnpmRunStage('static.web-deploy-source', 'check:static:assets'),
        pnpmRunStage('typecheck.coverage', 'typecheck:coverage', {heavyWeight: 1}),
        pnpmRunStage('test.coverage', 'test:coverage', {heavyWeight: 1}),
        pnpmRunStage('fallow.dupes', 'fallow:dupes', {heavyWeight: 1}),
        pnpmRunStage('native.test', 'test:rust', {heavyWeight: 1}),
        pnpmRunStage('native.resource-matrix', 'check:resources:matrix'),
        pnpmRunStage(
            'electron.quarantine',
            'test:e2e:electron:quarantine:headless',
            {heavyWeight: 2},
        ),
    ];
}
function hashFiles(filePaths, extraValues = [], root = projectRoot) {
    const hash = createHash('sha256');
    for (const value of extraValues) {
        hash.update(String(value));
        hash.update('\0');
    }
    for (const filePath of filePaths) {
        hash.update(filePath);
        hash.update('\0');
        try {
            hash.update(readFileSync(path.join(root, filePath)));
        } catch (error) {
            hash.update(`missing:${error?.code ?? 'unknown'}`);
        }
        hash.update('\0');
    }
    return hash.digest('hex');
}
export function getLintCachePaths({
    arch = process.arch,
    nodeVersion = process.version,
    platform = process.platform,
    root = projectRoot,
} = {}) {
    const ignoredDirectories = new Set([
        '.devkit',
        '.git',
        '.nuxt',
        '.tmp',
        'dist-electron',
        'native',
        'node_modules',
        'nuxt-output',
        'release',
    ]);
    const tsconfigFiles = [];
    function visit(directory) {
        for (const entry of readdirSync(path.join(root, directory), {withFileTypes: true})) {
            const relativePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) {
                    visit(relativePath);
                }
                continue;
            }
            if (/^tsconfig.*\.json$/u.test(entry.name)) {
                tsconfigFiles.push(normalizePath(relativePath));
            }
        }
    }
    visit('');
    const fingerprint = hashFiles([
        'eslint.config.mjs',
        'eslint-plugin-custom.mjs',
        'landing/eslint.config.mjs',
        'stylelint.config.mjs',
        'package.json',
        'pnpm-lock.yaml',
        ...tsconfigFiles.sort(),
    ], [
        nodeVersion,
        platform,
        arch,
    ], root).slice(0, 20);
    const cacheRoot = path.join(root, '.devkit', 'cache', 'lint', fingerprint);
    return {
        cacheRoot,
        eslint: path.join(cacheRoot, 'eslint.cache'),
        fingerprint,
        landingEslint: path.join(cacheRoot, 'landing-eslint.cache'),
        stylelint: path.join(cacheRoot, 'stylelint.cache'),
    };
}
async function lintTargets(files) {
    const existingFiles = files.filter(file => existsSync(path.join(projectRoot, file)));
    const eslintCandidates = existingFiles.filter(file => !file.startsWith('landing/') && (
        lintableSourcePattern.test(file)
    ));
    const { ESLint } = await import('eslint');
    const rootEslint = new ESLint({cwd: projectRoot});
    const ignored = await Promise.all(eslintCandidates.map(file => rootEslint.isPathIgnored(file)));
    const eslint = eslintCandidates.filter((_, index) => !ignored[index]);
    const landing = existingFiles.filter(file => file.startsWith('landing/') && (
        lintableSourcePattern.test(file)
    ));
    const stylelint = existingFiles.filter(file => /\.(?:vue|scss|css)$/u.test(file) && (
        file.startsWith('app/') || file.startsWith('landing/app/')
    ));
    return {
        eslint: unique(eslint),
        landing: unique(landing),
        stylelint: unique(stylelint),
    };
}
export async function pruneRetentionEntries({
    keep = 100,
    minimumAgeMs = 10 * 60_000,
    nowMs = Date.now(),
    root,
} = {}) {
    let entries;
    try {
        entries = await readdir(root, {withFileTypes: true});
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const candidates = await Promise.all(entries.map(async entry => ({
        entry,
        metadata: await stat(path.join(root, entry.name)),
    })));
    candidates.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
    const removed = [];
    for (const {
        entry,
        metadata,
    } of candidates.slice(keep)) {
        if (minimumAgeMs > 0 && nowMs - metadata.mtimeMs < minimumAgeMs) {
            continue;
        }
        await rm(path.join(root, entry.name), {
            force: true,
            recursive: entry.isDirectory(),
        });
        removed.push(entry.name);
    }
    return removed;
}
async function runLint(argv) {
    const changed = argv.includes('--changed');
    const fix = argv.includes('--fix');
    const all = argv.includes('--all');
    const noCache = argv.includes('--no-cache');
    const explicitFiles = readArgs(argv, 'file');
    const changes = changed
        ? await collectValidationChanges({
            base: readArg(argv, 'base'),
            explicitFiles,
        })
        : {
            files: [],
            known: true,
        };
    const full = !changed || !changes.known;
    const targets = full
        ? {
            eslint: [
                'app',
                'electron',
                'packages',
                'scripts',
                'server',
                'tests',
                'eslint-plugin-custom.mjs',
                'vitest.config.ts',
                'vitest.shared.config.ts',
            ],
            landing: all ? ['landing'] : [],
            stylelint: [all ? '{app,landing/app}/**/*.{vue,scss,css}' : 'app/**/*.{vue,scss,css}'],
        }
        : await lintTargets(changes.files);
    const cachePaths = getLintCachePaths();
    if (!noCache) {
        await mkdir(cachePaths.cacheRoot, {recursive: true});
        await pruneRetentionEntries({
            keep: 3,
            minimumAgeMs: 60 * 60_000,
            root: path.dirname(cachePaths.cacheRoot),
        });
    }
    const eslintCacheWarm = !noCache && existsSync(cachePaths.eslint);
    const commands = [];
    if (targets.eslint.length > 0) {
        commands.push(stage('lint.eslint', 'pnpm', [
            'exec',
            'eslint',
            ...targets.eslint,
            ...(fix ? ['--fix'] : ['--report-unused-disable-directives']),
            '--max-warnings=0',
            ...(!noCache ? [
                '--cache',
                '--cache-strategy=content',
                `--cache-location=${cachePaths.eslint}`,
            ] : []),
            ...(!changed && !eslintCacheWarm
                ? [`--concurrency=${parsePositiveInteger(process.env.EVB_ESLINT_WORKERS, 1)}`]
                : []),
        ], {
            ...(!noCache ? {cachePath: cachePaths.eslint} : {}),
            env: withNodeHeap(process.env, 6144),
            heavyWeight: full ? (eslintCacheWarm ? 1 : 2) : 0,
            inputFingerprint: cachePaths.fingerprint,
        }));
    }
    if (targets.landing.length > 0) {
        commands.push(
            stage('lint.landing-naming', 'pnpm', [
                'exec',
                'eslint',
                ...targets.landing,
                '--no-ignore',
                ...(fix ? ['--fix'] : ['--report-unused-disable-directives']),
                '--max-warnings=0',
            ], {env: {EVB_ESLINT_NAMING_ONLY: '1'}}),
            stage('lint.landing', 'pnpm', [
                '--dir',
                'landing',
                'exec',
                'eslint',
                '.',
                ...(fix ? ['--fix'] : []),
                '--max-warnings=0',
                ...(!noCache ? [
                    '--cache',
                    '--cache-strategy=content',
                    `--cache-location=${cachePaths.landingEslint}`,
                ] : []),
            ], {
                ...(!noCache ? {cachePath: cachePaths.landingEslint} : {}),
                env: withNodeHeap(process.env, 6144),
                inputFingerprint: cachePaths.fingerprint,
            }),
        );
    }
    if (targets.stylelint.length > 0) {
        commands.push(stage('lint.stylelint', 'pnpm', [
            'exec',
            'stylelint',
            ...targets.stylelint,
            ...(fix ? ['--fix'] : []),
            ...(!noCache ? [
                '--cache',
                `--cache-location=${cachePaths.stylelint}`,
            ] : []),
        ], {
            ...(!noCache ? {cachePath: cachePaths.stylelint} : {}),
            inputFingerprint: cachePaths.fingerprint,
        }));
    }
    const relevantFiles = full ? [] : changes.files;
    if (full || relevantFiles.some(file => file.startsWith('.github/'))) {
        commands.push(nodeStage('lint.github-actions', '--import', [
            'tsx',
            'scripts/checkGithubActionsSyntax.ts',
        ]));
    }
    if (full || relevantFiles.some(file => file.startsWith('app/') || file.startsWith('landing/app/'))) {
        const target = all || relevantFiles.some(file => file.startsWith('landing/'))
            ? 'all'
            : 'app';
        commands.push(
            nodeStage('lint.style-assets', '--import', [
                'tsx',
                'scripts/checkStyleAssetConventions.ts',
                `--target=${target}`,
            ]),
            nodeStage('lint.locales', '--import', [
                'tsx',
                'scripts/checkLocales.ts',
                `--target=${target}`,
            ]),
            nodeStage('lint.icons', '--import', [
                'tsx',
                'scripts/checkIconBundle.ts',
                `--target=${target}`,
            ]),
        );
    }
    if (
        full
        || relevantFiles.some(file => /^(?:app|electron|packages|scripts|server)\//u.test(file))
    ) {
        commands.push(nodeStage('lint.architecture', 'scripts/architecture/boundary-check.mjs', ['--scope=focused']));
    }
    await runStages(commands, {
        changes,
        tier: all ? 'lint-all' : (changed ? 'lint-changed' : 'lint'),
    });
}

function heavyGateRoot(env = process.env) {
    if (env.EVB_GATE_SEMAPHORE_DIR) {
        return path.resolve(env.EVB_GATE_SEMAPHORE_DIR);
    }
    const base = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches')
        : (env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
    return path.join(base, 'evb-viewer', 'heavy-gates');
}
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid < 1) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}
async function readJson(filePath) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
        return null;
    }
}
async function acquireMutationLock(root, nowMs) {
    const lockPath = path.join(root, 'mutation.lock');
    try {
        const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        await handle.writeFile(JSON.stringify({
            createdAtMs: nowMs,
            pid: process.pid,
        }));
        await handle.close();
        return async () => {
            await unlink(lockPath).catch(() => undefined);
        };
    } catch (error) {
        if (error?.code !== 'EEXIST') {
            throw error;
        }
    }

    const owner = await readJson(lockPath);
    let lockAgeMs = Number.POSITIVE_INFINITY;
    try {
        lockAgeMs = nowMs - (await stat(lockPath)).mtimeMs;
    } catch {
        return null;
    }
    if (
        (owner && !isPidAlive(owner.pid))
        || (owner && nowMs - Number(owner.createdAtMs ?? 0) > 60_000)
        || (!owner && lockAgeMs > 60_000)
    ) {
        await unlink(lockPath).catch(() => undefined);
    }
    return null;
}
async function withMutationLock(root, callback) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const release = await acquireMutationLock(root, Date.now());
        if (release) {
            try {
                return await callback();
            } finally {
                await release();
            }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return null;
}

export async function acquireHeavyGate({
    env = process.env,
    capacity = parsePositiveInteger(env.EVB_GATE_CAPACITY, heavyGateDefaultCapacity),
    failOpenOnTimeout = false,
    id,
    root = heavyGateRoot(env),
    waitMs = parsePositiveInteger(env.EVB_GATE_WAIT_MS, heavyGateDefaultWaitMs),
    weight = 1,
} = {}) {
    if (env.EVB_HEAVY_GATE_HELD === '1' || weight < 1) {
        return {
            coordinated: true,
            release: async () => undefined,
        };
    }
    const boundedWeight = Math.min(weight, capacity);
    const holdersDir = path.join(root, 'holders');
    try {
        await mkdir(holdersDir, {
            mode: 0o700,
            recursive: true,
        });
    } catch (error) {
        process.stderr.write(`[gate] Heavy-gate coordination unavailable (${error.message}); continuing uncoordinated.\n`);
        return {
            coordinated: false,
            release: async () => undefined,
        };
    }

    const holderName = `${process.pid}-${randomUUID()}.json`;
    const holderPath = path.join(holdersDir, holderName);
    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
        const acquired = await withMutationLock(root, async () => {
            const holderNames = (await readdir(holdersDir)).filter(name => name.endsWith('.json'));
            let usedWeight = 0;
            for (const name of holderNames) {
                const candidatePath = path.join(holdersDir, name);
                const holder = await readJson(candidatePath);
                if (!holder || !isPidAlive(holder.pid)) {
                    await unlink(candidatePath).catch(() => undefined);
                    continue;
                }
                usedWeight += parsePositiveInteger(holder.weight, 1);
            }
            if (usedWeight + boundedWeight > capacity) {
                return false;
            }
            await writeFile(holderPath, JSON.stringify({
                acquiredAt: new Date().toISOString(),
                id,
                pid: process.pid,
                projectRoot,
                weight: boundedWeight,
            }), {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
            return true;
        });
        if (acquired) {
            return {
                coordinated: true,
                release: async () => {
                    await unlink(holderPath).catch(() => undefined);
                },
            };
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (failOpenOnTimeout) {
        process.stderr.write(
            `[gate] Timed out waiting ${waitMs}ms for heavy-gate capacity; continuing ${id} uncoordinated.\n`,
        );
        return {
            coordinated: false,
            release: async () => undefined,
        };
    }
    throw new Error(`Timed out waiting ${waitMs}ms for heavy-gate capacity for ${id}.`);
}

async function reportRepoSessions() {
    const worktreeOutput = await gitOutput([
        'worktree',
        'list',
        '--porcelain',
    ]);
    if (!worktreeOutput) {
        return;
    }
    const roots = worktreeOutput
        .split(/\r?\n/u)
        .filter(line => line.startsWith('worktree '))
        .map(line => line.slice('worktree '.length));
    const sessions = [];
    for (const root of roots) {
        const sessionRoot = path.join(root, '.devkit', 'sessions');
        try {
            const entries = await readdir(sessionRoot, {withFileTypes: true});
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    sessions.push({
                        name: entry.name,
                        root,
                    });
                }
            }
        } catch {
            // Worktrees without session state are normal.
        }
    }
    if (sessions.length > 0) {
        const defaultCount = sessions.filter(session => session.name === 'default').length;
        const isolatedCount = sessions.filter(session => session.name.startsWith('e2e-')).length;
        process.stdout.write(
            `[gate] Repo session inventory: ${sessions.length} directories across ${roots.length} worktrees `
            + `(${defaultCount} default, ${isolatedCount} isolated e2e). Report only; no cross-worktree cleanup performed.\n`,
        );
    }
}

async function spawnInherited(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            env,
            stdio: 'inherit',
        });
        child.on('error', reject);
        child.on('close', (status, signal) => {
            if (status === 0) {
                resolve();
                return;
            }
            reject(new Error(
                signal
                    ? `${command} ${args.join(' ')} exited after signal ${signal}`
                    : `${command} ${args.join(' ')} failed with status ${status ?? 1}`,
            ));
        });
    });
}

function stageInputFingerprint(stageDefinition, changes) {
    return stageDefinition.inputFingerprint ?? hashFiles(
        changes?.files ?? [],
        [
            stageDefinition.id,
            stageDefinition.command,
            ...stageDefinition.args,
            process.version,
        ],
    );
}

async function runStages(stages, {
    changes,
    tier,
} = {}) {
    const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const evidenceDir = path.join(projectRoot, '.devkit', 'analysis', 'gates');
    const evidencePath = path.join(evidenceDir, `${runId}.ndjson`);
    await mkdir(evidenceDir, {recursive: true});
    const evidence = createWriteStream(evidencePath, {
        encoding: 'utf8',
        flags: 'a',
        mode: 0o600,
    });
    const results = [];
    const runStarted = Date.now();
    evidence.write(`${JSON.stringify({
        changes,
        event: 'run-start',
        runId,
        startedAt: new Date(runStarted).toISOString(),
        tier,
    })}\n`);

    try {
        if (stages.some(stageDefinition => stageDefinition.heavyWeight > 0)) {
            await reportRepoSessions();
        }
        for (const stageDefinition of stages) {
            const cacheState = stageDefinition.cachePath
                ? (existsSync(stageDefinition.cachePath) ? 'warm' : 'cold')
                : 'not-applicable';
            const gate = await acquireHeavyGate({
                id: stageDefinition.id,
                weight: stageDefinition.heavyWeight,
            });
            const startedAtMs = Date.now();
            const inputFingerprint = stageInputFingerprint(stageDefinition, changes);
            evidence.write(`${JSON.stringify({
                cache: cacheState,
                command: [
                    stageDefinition.command,
                    ...stageDefinition.args,
                ],
                event: 'stage-start',
                heavyGateCoordinated: gate.coordinated,
                heavyWeight: stageDefinition.heavyWeight,
                id: stageDefinition.id,
                inputFingerprint,
                startedAt: new Date(startedAtMs).toISOString(),
            })}\n`);
            let status = 'passed';
            try {
                await spawnInherited(
                    stageDefinition.command,
                    stageDefinition.args,
                    {
                        ...process.env,
                        ...stageDefinition.env,
                        ...(stageDefinition.heavyWeight > 0
                            ? {EVB_HEAVY_GATE_HELD: '1'}
                            : {}),
                    },
                );
            } catch (error) {
                status = 'failed';
                throw error;
            } finally {
                await gate.release();
                const endedAtMs = Date.now();
                const result = {
                    cache: cacheState,
                    endedAt: new Date(endedAtMs).toISOString(),
                    id: stageDefinition.id,
                    inputFingerprint,
                    loadAverage: os.loadavg(),
                    status,
                    wallMs: endedAtMs - startedAtMs,
                };
                results.push(result);
                evidence.write(`${JSON.stringify({
                    event: 'stage-end',
                    ...result,
                })}\n`);
            }
        }
    } finally {
        const endedAtMs = Date.now();
        evidence.write(`${JSON.stringify({
            event: 'run-end',
            runId,
            slowestStages: [...results]
                .sort((left, right) => right.wallMs - left.wallMs)
                .slice(0, 5)
                .map(result => ({
                    id: result.id,
                    wallMs: result.wallMs,
                })),
            status: results.length === stages.length && results.every(result => result.status === 'passed')
                ? 'passed'
                : 'failed',
            wallMs: endedAtMs - runStarted,
        })}\n`);
        await new Promise(resolve => evidence.end(resolve));
        await pruneRetentionEntries({
            keep: 100,
            minimumAgeMs: 10 * 60_000,
            root: evidenceDir,
        });
        process.stdout.write(`[gate] Evidence: ${path.relative(projectRoot, evidencePath)}\n`);
        if (results.length > 0) {
            process.stdout.write([
                '[gate] Slowest stages:',
                ...[...results]
                    .sort((left, right) => right.wallMs - left.wallMs)
                    .slice(0, 5)
                    .map(result => `  ${result.id}: ${(result.wallMs / 1000).toFixed(2)}s`),
                '',
            ].join('\n'));
        }
    }
}

async function runTier(tier, argv) {
    const changes = await collectValidationChanges({
        base: readArg(argv, 'base'),
        explicitFiles: readArgs(argv, 'file'),
    });
    const classification = changes.known
        ? classifyValidationImpacts(changes.files)
        : {
            full: true,
            impacts: {},
            unmatchedFiles: [],
        };
    if (classification.unmatchedFiles.length > 0) {
        process.stderr.write(
            `[gate] Unclassified paths force the full ${tier} tier: ${classification.unmatchedFiles.join(', ')}\n`,
        );
    }
    if (!changes.known) {
        process.stderr.write(`[gate] Change impact is unknown (${changes.reason}); running the full ${tier} tier.\n`);
    }
    const plan = getValidationPlan({
        changes,
        classification,
        tier,
    });
    process.stdout.write(`[gate] ${tier}: ${plan.map(item => item.id).join(', ') || 'no affected stages'}\n`);
    await runStages(plan, {
        changes: {
            ...changes,
            classification,
        },
        tier,
    });
}

async function runHeavyCommand(argv) {
    const separatorIndex = argv.indexOf('--');
    if (separatorIndex < 0 || !argv[separatorIndex + 1]) {
        throw new Error('Usage: validation-gates.mjs heavy --id=<id> --weight=<n> -- <command> [args...]');
    }
    const command = argv[separatorIndex + 1];
    const args = argv.slice(separatorIndex + 2);
    await runStages([stage(
        readArg(argv, 'id') ?? 'heavy',
        command,
        args,
        {heavyWeight: parsePositiveInteger(readArg(argv, 'weight'), 1)},
    )], {tier: 'heavy'});
}

async function main() {
    const [
        command,
        ...argv
    ] = process.argv.slice(2);
    if (command === 'lint') {
        await runLint(argv);
        return;
    }
    if (command === 'heavy') {
        await runHeavyCommand(argv);
        return;
    }
    if (validationTiers.has(command)) {
        await runTier(command, argv);
        return;
    }
    throw new Error(
        'Usage: validation-gates.mjs <iteration|acceptance|integration|nightly|lint|heavy> [options]',
    );
}

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    await main().catch(async (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
