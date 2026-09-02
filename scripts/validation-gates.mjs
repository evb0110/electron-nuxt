#!/usr/bin/env node
/* eslint-disable max-lines -- The gate owner keeps scheduling, evidence, and impact policy in one inspectable module. */
import {
    execFileSync,
    spawn,
} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    constants as fsConstants,
    createWriteStream,
    existsSync,
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
} from 'node:fs';
import {
    mkdir,
    open,
    readFile,
    readdir,
    rename,
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
import {createAllGatesValidationStages} from './all-gates-validation-plan.mjs';

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
const heavyGateDefaultWaitMs = 30 * 60_000;
const validationCacheSchemaVersion = 1;
const validationCacheRootOnlyDirectories = new Set([
    '.devkit',
    '.tmp',
    'coverage',
    'dist-electron',
    'nuxt-output',
    'release',
]);
const validationCacheDirectoryNames = new Set([
    '.git',
    '.nuxt',
    '.output',
    'node_modules',
    'target',
]);
const validationInputHashCache = new Map();
const validationStageInputPaths = {
    build: [
        'app',
        'build',
        'electron',
        'native',
        'packages',
        'public',
        'resources',
        'scan-cleanup-adapters',
        'scan-cleanup-core',
        'server',
        'electron-builder.yml',
        'nuxt.config.ts',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'scripts',
        'tsconfig*.json',
    ],
    fallow: [
        '.fallow-dupes-baseline.json',
        'app',
        'electron',
        'landing',
        'packages',
        'scan-cleanup-adapters',
        'scan-cleanup-core',
        'scripts',
        'server',
        'tests',
        'nuxt.config.ts',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig*.json',
    ],
    lint: [
        'app',
        'electron',
        'landing',
        'packages',
        'scripts',
        'server',
        'tests',
        '.github',
        'eslint.config.mjs',
        'eslint.shared.mjs',
        'eslint-plugin-custom.mjs',
        'landing/eslint.config.mjs',
        'nuxt.config.ts',
        'stylelint.config.mjs',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig*.json',
        'vitest.config.ts',
        'vitest.shared.config.ts',
    ],
    native: [
        'native',
        'resources',
        'scripts/checkSearchNativeParity.ts',
        'scripts/check-native-tools-source-matrix.sh',
        'native/Cargo.toml',
        'native/Cargo.lock',
        'rust-toolchain.toml',
        'package.json',
        'pnpm-lock.yaml',
    ],
    'static-platform': [
        'app',
        'electron',
        'packages',
        'scripts/reportPlatformManifestConsumers.ts',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig*.json',
    ],
    'typecheck-coverage': [
        'app',
        'electron',
        'packages',
        'scripts',
        'server',
        'tests',
        'tsconfig*.json',
        'package.json',
        'pnpm-lock.yaml',
    ],
    typecheck: [
        'app',
        'electron',
        'packages',
        'scripts',
        'server',
        'tests',
        'nuxt.config.ts',
        'package.json',
        'pnpm-lock.yaml',
        'tsconfig*.json',
    ],
    'web-deploy': [
        '.vercelignore',
        'app',
        'nuxt.config.ts',
        'package.json',
        'patches',
        'public',
        'scan-cleanup-adapters',
        'scan-cleanup-core',
        'scripts/check-web-deploy-source.mjs',
        'scripts/deployVercelPrivate.mjs',
        'server',
        'vercel.json',
    ],
};
const validationToolPackages = [
    'electron-builder',
    'eslint',
    'esbuild',
    'fallow',
    'nuxt',
    'stylelint',
    'type-coverage',
    'typescript',
    'tsx',
    'vitest',
    'vue-tsc',
];
const validationEnvironmentKeys = new Set([
    'CI',
    'EVB_ELECTRON_SOURCEMAP',
    'EVB_NATIVE_TARGET_ARCH',
    'EVB_NATIVE_TARGET_PLATFORM',
    'EVB_STRICT_BUILD_SKIP_WASM_CHECK',
    'NODE_ENV',
    'RUSTFLAGS',
    'TARGET_ARCH',
    'npm_config_arch',
]);
const toolVersionCache = new Map();
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
export function getDefaultGateCapacity() {
    return typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : Math.max(os.cpus().length, 1);
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
        dependsOn: [],
        heavyWeight: 0,
        weight: 1,
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
    ], {
        additionalInputPaths: files,
        cacheable: true,
        inputScope: 'lint',
        weight: 2,
    }));
    if (typecheck.nuxt) {
        stages.push(nodeStage('typecheck.nuxt', 'scripts/run-nuxt-typecheck.mjs', [], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'typecheck',
        }));
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
        ], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'typecheck',
        }));
    }
    if (tier === 'iteration') {
        const relatedFiles = files.filter(file => /\.(?:[cm]?[jt]sx?|vue)$/u.test(file));
        if (relatedFiles.length > 0 && selectedUnits.length > 0) {
            stages.push(vitestRelatedStage(
                'test.unit.related',
                selectedUnits,
                relatedFiles,
                {
                    heavyWeight: 4,
                    weight: 4,
                },
            ));
        }
        return stages;
    }

    if (selectedUnits.length > 0) {
        stages.push(vitestStage('test.unit.affected-projects', selectedUnits, [], {
            heavyWeight: 4,
            weight: 4,
        }));
    }
    stages.push(pnpmRunStage('fallow.dead-code', 'fallow', {
        cacheable: true,
        heavyWeight: 1,
        inputScope: 'fallow',
    }));
    if (classification.impacts.webDeploy) {
        stages.push(nodeStage('static.web-deploy-source', 'scripts/check-web-deploy-source.mjs', ['--allow-dirty'], {
            cacheable: true,
            inputScope: 'web-deploy',
        }));
    }
    if (classification.impacts.landing) {
        stages.push(stage('landing.typecheck', 'pnpm', [
            '--dir',
            'landing',
            'run',
            'typecheck',
        ], {
            additionalInputPaths: files,
            cacheable: true,
            inputScope: 'typecheck',
        }));
    }
    if (classification.impacts.native) {
        stages.push(
            pnpmRunStage('native.lint', 'lint:rust', {
                cacheable: true,
                heavyWeight: 2,
                inputScope: 'native',
                weight: 2,
            }),
            pnpmRunStage('native.test', 'test:rust', {
                heavyWeight: 4,
                weight: 4,
            }),
            pnpmRunStage('native.resource-matrix', 'check:resources:matrix', {
                cacheable: true,
                inputScope: 'native',
            }),
        );
    }
    if (classification.impacts.native || classification.impacts.build) {
        stages.push(pnpmRunStage('build.strict', 'build:strict', {
            heavyWeight: 2,
            inputScope: 'build',
            weight: 2,
        }));
    }
    if (classification.impacts.app || classification.impacts.electron) {
        stages.push(pnpmRunStage(
            'electron.blocking-smoke',
            'test:e2e:electron:blocking-smoke:headless',
            {
                dependsOn: stages.some(item => item.id === 'build.strict')
                    ? ['build.strict']
                    : [],
                heavyWeight: 3,
                inputScope: 'build',
                weight: 3,
            },
        ));
    }
    return stages;
}
export function getValidationPlan({
    allGates = false,
    cold = false,
    changes,
    classification = classifyValidationImpacts(changes.files),
    tier,
}) {
    if (!validationTiers.has(tier)) {
        throw new Error(`Unknown validation tier "${tier}".`);
    }
    const mustRunFull = allGates
        || !changes.known
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
            pnpmRunStage('lint.full', cold ? 'lint:clean' : 'lint', {
                cacheable: true,
                heavyWeight: 2,
                inputScope: 'lint',
                weight: 2,
            }),
            pnpmRunStage('typecheck.full', cold ? 'typecheck:clean' : 'typecheck', {
                cacheable: true,
                heavyWeight: 1,
                inputScope: 'typecheck',
            }),
            pnpmRunStage('test.unit.full', 'test:unit', {
                heavyWeight: 4,
                weight: 4,
            }),
        ];
    }

    if (allGates && tier === 'acceptance') {
        return createAllGatesValidationStages({cold});
    }

    const fullStages = [
        pnpmRunStage('lint.full', cold || tier !== 'acceptance' ? 'lint:clean' : 'lint', {
            cacheable: true,
            heavyWeight: 2,
            inputScope: 'lint',
            weight: 2,
        }),
        pnpmRunStage('typecheck.full', cold || tier !== 'acceptance' ? 'typecheck:clean' : 'typecheck', {
            cacheable: true,
            heavyWeight: 1,
            inputScope: 'typecheck',
        }),
        ...(tier === 'nightly'
            ? []
            : [pnpmRunStage('test.unit.full', 'test:unit', {
                heavyWeight: 4,
                weight: 4,
            })]),
        pnpmRunStage('fallow.dead-code', 'fallow', {
            cacheable: true,
            heavyWeight: 1,
            inputScope: 'fallow',
        }),
        ...(tier === 'acceptance'
            ? [pnpmRunStage('fallow.dupes', 'fallow:dupes', {
                cacheable: true,
                heavyWeight: 1,
                inputScope: 'fallow',
            })]
            : []),
        pnpmRunStage('build.strict', 'build:strict', {
            heavyWeight: 2,
            inputScope: 'build',
            weight: 2,
        }),
    ];
    if (tier === 'iteration' || tier === 'acceptance' || tier === 'integration') {
        if (tier === 'acceptance') {
            fullStages.push(pnpmRunStage(
                'electron.bundle-integrity',
                'test:electron-bundle-static-integrity:no-build',
                {
                    dependsOn: ['build.strict'],
                    inputScope: 'build',
                },
            ));
            fullStages.push(pnpmRunStage(
                'electron.blocking-smoke',
                'test:e2e:electron:blocking-smoke:headless',
                {
                    dependsOn: [
                        'build.strict',
                        'electron.bundle-integrity',
                    ],
                    heavyWeight: 3,
                    inputScope: 'build',
                    weight: 3,
                },
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
        pnpmRunStage('static.platform-report', 'check:static:reports', {
            cacheable: true,
            inputScope: 'static-platform',
        }),
        pnpmRunStage('static.web-deploy-source', 'check:static:assets', {
            args: [
                'run',
                'check:static:assets',
                '--allow-dirty',
            ],
            cacheable: true,
            inputScope: 'web-deploy',
        }),
        pnpmRunStage('typecheck.coverage', 'typecheck:coverage', {
            cacheable: true,
            heavyWeight: 2,
            inputScope: 'typecheck-coverage',
            weight: 2,
        }),
        pnpmRunStage('test.coverage', 'test:coverage', {
            heavyWeight: 4,
            weight: 4,
        }),
        ...(tier === 'nightly'
            ? [pnpmRunStage('fallow.dupes', 'fallow:dupes', {
                cacheable: true,
                heavyWeight: 1,
                inputScope: 'fallow',
            })]
            : []),
        pnpmRunStage('native.test', 'test:rust', {
            heavyWeight: 4,
            weight: 4,
        }),
        pnpmRunStage('native.resource-matrix', 'check:resources:matrix', {
            cacheable: true,
            dependsOn: ['build.strict'],
            env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
            inputScope: 'native',
        }),
        pnpmRunStage(
            'electron.quarantine',
            'test:e2e:electron:quarantine:headless',
            {
                heavyWeight: 3,
                inputScope: 'build',
                weight: 3,
            },
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
function pathPatternToRegExp(pattern) {
    return new RegExp(`^${pattern
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
        .join('.*')}$`, 'u');
}
function expandValidationInputPath(inputPath, root) {
    const normalizedInputPath = normalizePath(inputPath);
    if (!normalizedInputPath.includes('*')) {
        return [normalizedInputPath];
    }
    const directory = path.posix.dirname(normalizedInputPath);
    const basename = path.posix.basename(normalizedInputPath);
    const directoryPath = path.join(root, directory === '.' ? '' : directory);
    try {
        return readdirSync(directoryPath)
            .filter(entry => pathPatternToRegExp(basename).test(entry))
            .map(entry => path.posix.join(directory === '.' ? '' : directory, entry));
    } catch {
        return [];
    }
}
function collectValidationInputFiles(inputPaths, root) {
    const files = new Set();
    const missing = new Set();
    const visit = (relativePath) => {
        const absolutePath = path.join(root, relativePath);
        let metadata;
        try {
            metadata = lstatSync(absolutePath);
        } catch {
            missing.add(relativePath);
            return;
        }
        if (metadata.isDirectory()) {
            const normalizedDirectory = normalizePath(relativePath);
            if (
                validationCacheRootOnlyDirectories.has(normalizedDirectory)
                || validationCacheDirectoryNames.has(path.posix.basename(normalizedDirectory))
            ) {
                return;
            }
            let entries;
            try {
                entries = readdirSync(absolutePath).sort((left, right) => left.localeCompare(right, 'en'));
            } catch {
                missing.add(relativePath);
                return;
            }
            for (const entry of entries) {
                visit(path.posix.join(relativePath, entry));
            }
            return;
        }
        files.add(normalizePath(relativePath));
    };
    for (const inputPath of inputPaths) {
        const expandedPaths = expandValidationInputPath(inputPath, root);
        if (expandedPaths.length === 0) {
            missing.add(normalizePath(inputPath));
            continue;
        }
        for (const expandedPath of expandedPaths) {
            visit(expandedPath);
        }
    }
    return {
        files: [...files].sort(),
        missing: [...missing].sort(),
    };
}
function validationFileDigest(absolutePath, metadata) {
    const cached = validationInputHashCache.get(absolutePath);
    if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
        return cached.digest;
    }
    const digest = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
    validationInputHashCache.set(absolutePath, {
        digest,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
    });
    return digest;
}
function hashValidationInputs(inputPaths, root) {
    const {
        files,
        missing,
    } = collectValidationInputFiles(inputPaths, root);
    const hash = createHash('sha256');
    for (const relativePath of files) {
        hash.update(relativePath);
        hash.update('\0');
        const absolutePath = path.join(root, relativePath);
        const metadata = lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) {
            hash.update(`symlink:${readlinkSync(absolutePath)}`);
        } else {
            hash.update(validationFileDigest(absolutePath, metadata));
        }
        hash.update('\0');
    }
    for (const relativePath of missing) {
        hash.update(`missing:${relativePath}\0`);
    }
    return hash.digest('hex');
}
function readPackageVersion(packageName, root) {
    const cacheKey = `${root}\0package:${packageName}`;
    if (toolVersionCache.has(cacheKey)) {
        return toolVersionCache.get(cacheKey);
    }
    let version = 'unavailable';
    try {
        const packageJson = JSON.parse(readFileSync(
            path.join(root, 'node_modules', packageName, 'package.json'),
            'utf8',
        ));
        version = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
    } catch {
        // A missing optional tool still belongs in the key so a later install cannot reuse stale evidence.
    }
    toolVersionCache.set(cacheKey, version);
    return version;
}
function readCommandVersion(command, args, root) {
    const cacheKey = `${root}\0command:${command} ${args.join(' ')}`;
    if (toolVersionCache.has(cacheKey)) {
        return toolVersionCache.get(cacheKey);
    }
    let version = 'unavailable';
    try {
        version = execFileSync(command, args, {
            cwd: root,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
    } catch {
        // Keep the unavailable marker in the fingerprint. A newly available tool invalidates the old key.
    }
    toolVersionCache.set(cacheKey, version);
    return version;
}
function validationToolVersions(tools, root) {
    const versions = {node: process.version};
    const requestedTools = new Set(tools);
    if (requestedTools.has('pnpm')) {
        versions.pnpm = readCommandVersion('pnpm', ['--version'], root);
    }
    for (const packageName of validationToolPackages) {
        if (requestedTools.has(packageName)) {
            versions[packageName] = readPackageVersion(packageName, root);
        }
    }
    if (requestedTools.has('cargo')) {
        versions.cargo = readCommandVersion('cargo', ['--version'], root);
    }
    if (requestedTools.has('rustc')) {
        versions.rustc = readCommandVersion('rustc', ['--version'], root);
    }
    return versions;
}
function validationEnvironmentValues() {
    return Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => validationEnvironmentKeys.has(key)
            || key.startsWith('CARGO_')
            || key.startsWith('NUXT_')
            || key.startsWith('VITE_'))
        .sort(([left], [right]) => left.localeCompare(right, 'en')));
}
function inferValidationTools(stageDefinition) {
    if (stageDefinition.tools) {
        return stageDefinition.tools;
    }
    if (stageDefinition.inputScope === 'native') {
        return [
            'pnpm',
            'cargo',
            'rustc',
            'tsx',
        ];
    }
    if (stageDefinition.inputScope === 'typecheck') {
        return [
            'pnpm',
            'typescript',
            'vue-tsc',
            'nuxt',
        ];
    }
    if (stageDefinition.inputScope === 'typecheck-coverage') {
        return [
            'pnpm',
            'type-coverage',
            'typescript',
            'tsx',
        ];
    }
    if (stageDefinition.inputScope === 'lint') {
        return [
            'pnpm',
            'eslint',
            'stylelint',
        ];
    }
    if (stageDefinition.inputScope === 'fallow') {
        return [
            'pnpm',
            'fallow',
        ];
    }
    if (stageDefinition.inputScope === 'build') {
        return [
            'cargo',
            'electron-builder',
            'esbuild',
            'pnpm',
            'nuxt',
            'rustc',
            'tsx',
        ];
    }
    if (stageDefinition.inputScope === 'static-platform') {
        return [
            'pnpm',
            'tsx',
        ];
    }
    return ['pnpm'];
}
export function getValidationInputFingerprint({
    additionalInputPaths = [],
    extraValues = [],
    inputPaths = [],
    inputScope,
    root = projectRoot,
    tools = [],
} = {}) {
    const paths = unique([
        ...(inputScope ? validationStageInputPaths[inputScope] ?? [] : []),
        ...inputPaths,
        ...additionalInputPaths,
    ]);
    const inputHash = hashValidationInputs(paths, root);
    const hash = createHash('sha256');
    hash.update(inputHash);
    hash.update('\0');
    hash.update(JSON.stringify({
        environment: validationEnvironmentValues(),
        extraValues,
        tools: validationToolVersions(tools, root),
    }));
    return hash.digest('hex');
}
const validationBuildOutputPaths = [
    'dist-electron',
    'nuxt-output',
    '.tmp/native-build-manifest',
];
function collectValidationOutputState(root, outputPaths) {
    const entries = [];
    const visit = relativePath => {
        const absolutePath = path.join(root, relativePath);
        let metadata;
        try {
            metadata = lstatSync(absolutePath);
        } catch {
            entries.push(`missing:${relativePath}`);
            return;
        }
        entries.push([
            normalizePath(relativePath),
            metadata.isDirectory() ? 'directory' : (metadata.isSymbolicLink() ? 'symlink' : 'file'),
            metadata.mode,
            metadata.size,
            metadata.mtimeMs,
        ].join(':'));
        if (metadata.isSymbolicLink()) {
            entries.push(`link:${relativePath}:${readlinkSync(absolutePath)}`);
            return;
        }
        if (!metadata.isDirectory()) {
            return;
        }
        for (const entry of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right, 'en'))) {
            visit(path.posix.join(relativePath, entry));
        }
    };
    for (const outputPath of outputPaths) {
        visit(normalizePath(outputPath));
    }
    return entries.sort().join('\n');
}
export function getValidationBuildMarkerPath(root = projectRoot) {
    return path.join(root, '.devkit', 'cache', 'build', 'strict.json');
}
function getValidationBuildInputFingerprint(buildScriptName, root) {
    return getValidationInputFingerprint({
        extraValues: [
            'strict-build',
            buildScriptName,
        ],
        inputScope: 'build',
        root,
        tools: [
            'pnpm',
            'nuxt',
        ],
    });
}
export async function writeValidationBuildMarker({
    buildScriptName,
    outputPaths = validationBuildOutputPaths,
    root = projectRoot,
} = {}) {
    const outputState = collectValidationOutputState(root, outputPaths);
    if (outputState.includes('missing:')) {
        return null;
    }
    const markerPath = getValidationBuildMarkerPath(root);
    const temporaryPath = `${markerPath}.${process.pid}.tmp`;
    await mkdir(path.dirname(markerPath), {recursive: true});
    await writeFile(temporaryPath, `${JSON.stringify({
        buildScriptName,
        inputFingerprint: getValidationBuildInputFingerprint(buildScriptName, root),
        outputState,
        schemaVersion: validationCacheSchemaVersion,
        writtenAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await rename(temporaryPath, markerPath);
    return markerPath;
}
export function isValidationBuildFresh({
    buildScriptName,
    outputPaths = validationBuildOutputPaths,
    root = projectRoot,
} = {}) {
    let marker;
    try {
        marker = JSON.parse(readFileSync(getValidationBuildMarkerPath(root), 'utf8'));
    } catch {
        return false;
    }
    if (
        marker?.schemaVersion !== validationCacheSchemaVersion
        || marker.buildScriptName !== buildScriptName
        || marker.inputFingerprint !== getValidationBuildInputFingerprint(buildScriptName, root)
    ) {
        return false;
    }
    const outputState = collectValidationOutputState(root, outputPaths);
    return !outputState.includes('missing:') && outputState === marker.outputState;
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
        `eslint=${readPackageVersion('eslint', root)}`,
        `stylelint=${readPackageVersion('stylelint', root)}`,
        `pnpm=${readCommandVersion('pnpm', ['--version'], root)}`,
    ], root).slice(0, 20);
    const cacheRoot = path.join(root, '.devkit', 'cache', 'eslint', fingerprint);
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
    const noCache = argv.includes('--no-cache') || process.env.EVB_GATE_NO_CACHE === '1';
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
    const relevantFiles = full ? [] : changes.files;
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
            additionalInputPaths: relevantFiles,
            cacheable: true,
            env: withNodeHeap(process.env, 6144),
            heavyWeight: full ? (eslintCacheWarm ? 1 : 2) : 0,
            inputScope: 'lint',
            weight: full ? (eslintCacheWarm ? 1 : 2) : 1,
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
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                env: {EVB_ESLINT_NAMING_ONLY: '1'},
                inputScope: 'lint',
            }),
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
                additionalInputPaths: relevantFiles,
                cacheable: true,
                env: withNodeHeap(process.env, 6144),
                inputScope: 'lint',
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
            additionalInputPaths: relevantFiles,
            cacheable: true,
            inputScope: 'lint',
        }));
    }
    if (full || relevantFiles.some(file => file.startsWith('.github/'))) {
        commands.push(nodeStage('lint.github-actions', '--import', [
            'tsx',
            'scripts/checkGithubActionsSyntax.ts',
        ], {
            additionalInputPaths: relevantFiles,
            cacheable: true,
            inputScope: 'lint',
        }));
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
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                inputScope: 'lint',
            }),
            nodeStage('lint.locales', '--import', [
                'tsx',
                'scripts/checkLocales.ts',
                `--target=${target}`,
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                inputScope: 'lint',
            }),
            nodeStage('lint.icons', '--import', [
                'tsx',
                'scripts/checkIconBundle.ts',
                `--target=${target}`,
            ], {
                additionalInputPaths: relevantFiles,
                cacheable: true,
                inputScope: 'lint',
            }),
        );
    }
    if (
        full
        || relevantFiles.some(file => /^(?:app|electron|packages|scripts|server)\//u.test(file))
    ) {
        commands.push(nodeStage('lint.architecture', 'scripts/architecture/boundary-check.mjs', ['--scope=focused'], {
            additionalInputPaths: relevantFiles,
            cacheable: true,
            inputScope: 'lint',
        }));
    }
    await runStages(commands, {
        changes,
        noCache,
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
    } catch (error) {
        return error?.code === 'EPERM';
    }
    if (process.platform === 'win32') {
        return true;
    }
    let state = '';
    try {
        if (process.platform === 'linux') {
            const procStat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
            state = procStat.slice(procStat.lastIndexOf(')') + 1).trimStart().charAt(0);
        } else {
            state = execFileSync('ps', [
                '-p',
                String(pid),
                '-o',
                'stat=',
            ], {
                encoding: 'utf8',
                stdio: [
                    'ignore',
                    'pipe',
                    'ignore',
                ],
            }).trim().charAt(0);
        }
    } catch {
        // The process may exit between kill(0) and the state read. Probe again
        // before treating an unavailable state as a live holder.
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return error?.code === 'EPERM';
        }
    }
    return state !== 'Z' && state !== 'X';
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
    capacity = parsePositiveInteger(env.EVB_GATE_CAPACITY, getDefaultGateCapacity()),
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

async function readLastPassingStageFingerprints(evidenceDir) {
    let entries;
    try {
        entries = await readdir(evidenceDir, {withFileTypes: true});
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return new Map();
        }
        throw error;
    }
    const evidenceFiles = (await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.ndjson'))
        .map(async entry => {
            const filePath = path.join(evidenceDir, entry.name);
            try {
                return {
                    filePath,
                    modifiedAtMs: (await stat(filePath)).mtimeMs,
                };
            } catch {
                return null;
            }
        }))).filter(Boolean);
    evidenceFiles.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    const fingerprints = new Map();
    for (const {filePath} of evidenceFiles) {
        const stageResults = [];
        let runPassed = false;
        try {
            const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/u);
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }
                if (event.event === 'run-end') {
                    runPassed = event.status === 'passed';
                } else if (event.event === 'stage-end' && event.status === 'passed') {
                    stageResults.push(event);
                }
            }
        } catch {
            continue;
        }
        if (!runPassed) {
            continue;
        }
        for (const result of stageResults) {
            if (
                typeof result.id === 'string'
                && typeof result.inputFingerprint === 'string'
                && !fingerprints.has(result.id)
            ) {
                fingerprints.set(result.id, result.inputFingerprint);
            }
        }
    }
    return fingerprints;
}

function stageInputFingerprint(stageDefinition, changes) {
    if (stageDefinition.inputFingerprint) {
        return stageDefinition.inputFingerprint;
    }
    return getValidationInputFingerprint({
        additionalInputPaths: stageDefinition.additionalInputPaths ?? [],
        extraValues: [
            validationCacheSchemaVersion,
            stageDefinition.id,
            stageDefinition.command,
            ...stageDefinition.args,
            JSON.stringify(stageDefinition.dependsOn ?? []),
            JSON.stringify(stageDefinition.env ?? {}),
            process.platform,
            process.arch,
            process.version,
        ],
        inputPaths: stageDefinition.inputPaths ?? (
            stageDefinition.inputScope ? [] : (changes?.files ?? [])
        ),
        inputScope: stageDefinition.inputScope,
        tools: inferValidationTools(stageDefinition),
    });
}
export function getValidationStageCacheDecision(stageDefinition, {
    changes,
    lastPassingFingerprints = new Map(),
    noCache = false,
} = {}) {
    const inputFingerprint = stageDefinition.inputFingerprint
        ?? stageInputFingerprint(stageDefinition, changes);
    const cacheHit = !noCache
        && stageDefinition.cacheable === true
        && lastPassingFingerprints.get(stageDefinition.id) === inputFingerprint;
    const cacheState = stageDefinition.cacheable === true
        ? (cacheHit ? 'warm' : 'cold')
        : (stageDefinition.cachePath
            ? (existsSync(stageDefinition.cachePath) ? 'warm' : 'cold')
            : 'not-applicable');
    return {
        cacheHit,
        cacheReason: cacheHit
            ? 'last-passing-input-fingerprint'
            : (noCache ? 'cache-disabled' : (stageDefinition.cacheable ? 'input-fingerprint-miss' : 'not-cacheable')),
        cacheState,
        inputFingerprint,
    };
}

function stageResourceWeight(stageDefinition, capacity) {
    const requested = Number.isFinite(stageDefinition.weight)
        ? stageDefinition.weight
        : (stageDefinition.heavyWeight > 0 ? stageDefinition.heavyWeight : 1);
    return Math.max(1, Math.min(Math.floor(requested), capacity));
}

export async function runStagePool(stages, runStage, {capacity = getDefaultGateCapacity()} = {}) {
    const effectiveCapacity = Math.max(1, Math.floor(capacity));
    const stageById = new Map();
    stages.forEach((stageDefinition, index) => {
        if (!stageDefinition.id || stageById.has(stageDefinition.id)) {
            throw new Error(`Validation stages must have unique ids; duplicate "${stageDefinition.id}" at index ${index}.`);
        }
        stageById.set(stageDefinition.id, stageDefinition);
    });
    for (const stageDefinition of stages) {
        for (const dependency of stageDefinition.dependsOn ?? []) {
            if (!stageById.has(dependency)) {
                throw new Error(`Validation stage "${stageDefinition.id}" depends on unknown stage "${dependency}".`);
            }
            if (dependency === stageDefinition.id) {
                throw new Error(`Validation stage "${stageDefinition.id}" cannot depend on itself.`);
            }
        }
    }

    const pending = new Set(stages.map(stageDefinition => stageDefinition.id));
    const completed = new Set();
    const running = new Map();
    const failures = [];
    const skipped = [];
    let usedCapacity = 0;
    // A failed stage takes its transitive dependents out of the plan; every
    // independent stage still runs so one pass reports every failure.
    const skipDependents = (failedId) => {
        for (const stageDefinition of stages) {
            if (pending.has(stageDefinition.id) && (stageDefinition.dependsOn ?? []).includes(failedId)) {
                pending.delete(stageDefinition.id);
                skipped.push({
                    dependency: failedId,
                    id: stageDefinition.id,
                });
                skipDependents(stageDefinition.id);
            }
        }
    };
    const stageIndex = new Map(stages.map((stageDefinition, index) => [
        stageDefinition.id,
        index,
    ]));

    const sortedReadyStages = () => stages
        .filter(stageDefinition => (
            pending.has(stageDefinition.id)
            && (stageDefinition.dependsOn ?? []).every(dependency => completed.has(dependency))
        ))
        .sort((left, right) => (
            Number(right.priority ?? 0) - Number(left.priority ?? 0)
            || stageResourceWeight(right, effectiveCapacity) - stageResourceWeight(left, effectiveCapacity)
            || stageIndex.get(left.id) - stageIndex.get(right.id)
        ));

    const launch = (stageDefinition) => {
        const weight = stageResourceWeight(stageDefinition, effectiveCapacity);
        pending.delete(stageDefinition.id);
        usedCapacity += weight;
        const promise = Promise.resolve()
            .then(() => runStage(stageDefinition))
            .then(
                () => ({
                    error: null,
                    ok: true,
                    stageDefinition,
                }),
                error => ({
                    error,
                    ok: false,
                    stageDefinition,
                }),
            );
        running.set(stageDefinition.id, {
            promise,
            stageDefinition,
            weight,
        });
    };

    while (pending.size > 0 || running.size > 0) {
        let launched = true;
        while (launched) {
            launched = false;
            const availableCapacity = effectiveCapacity - usedCapacity;
            const candidate = sortedReadyStages().find(stageDefinition => (
                stageResourceWeight(stageDefinition, effectiveCapacity) <= availableCapacity
            ));
            if (candidate) {
                launch(candidate);
                launched = true;
            }
        }

        if (running.size === 0) {
            if (pending.size === 0) {
                break;
            }
            throw new Error('Validation stage dependency graph contains a cycle or an unsatisfied dependency.');
        }

        const outcome = await Promise.race([...running.values()].map(entry => entry.promise));
        running.delete(outcome.stageDefinition.id);
        usedCapacity -= stageResourceWeight(outcome.stageDefinition, effectiveCapacity);
        if (outcome.ok) {
            completed.add(outcome.stageDefinition.id);
            continue;
        }
        failures.push({
            error: outcome.error,
            id: outcome.stageDefinition.id,
        });
        skipDependents(outcome.stageDefinition.id);
    }

    if (failures.length > 0) {
        throw new ValidationStagePoolError(failures, skipped);
    }
    return {
        failures,
        skipped,
    };
}

export class ValidationStagePoolError extends Error {
    constructor(failures, skipped) {
        const lines = failures.map(failure => `  ${failure.id}: ${failure.error?.message ?? failure.error}`);
        if (skipped.length > 0) {
            lines.push(`  skipped (dependency failed): ${skipped.map(entry => `${entry.id} <- ${entry.dependency}`).join(', ')}`);
        }
        super(`${failures.length} validation stage${failures.length === 1 ? '' : 's'} failed:\n${lines.join('\n')}`);
        this.name = 'ValidationStagePoolError';
        this.failures = failures;
        this.skipped = skipped;
    }
}

export function selectValidationStages(stages, requestedIds = []) {
    if (requestedIds.length === 0) {
        return stages;
    }
    const byId = new Map(stages.map(stageDefinition => [
        stageDefinition.id,
        stageDefinition,
    ]));
    const selectedIds = new Set();
    const include = id => {
        const stageDefinition = byId.get(id);
        if (!stageDefinition) {
            throw new Error(`Unknown validation stage "${id}". Available stages: ${[...byId.keys()].join(', ')}`);
        }
        if (selectedIds.has(id)) {
            return;
        }
        selectedIds.add(id);
        for (const dependency of stageDefinition.dependsOn ?? []) {
            include(dependency);
        }
    };
    requestedIds.forEach(include);
    return stages.filter(stageDefinition => selectedIds.has(stageDefinition.id));
}

async function runStages(stages, {
    changes,
    noCache = process.env.EVB_GATE_NO_CACHE === '1',
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
        cacheSchemaVersion: validationCacheSchemaVersion,
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
        const lastPassingFingerprints = noCache
            ? new Map()
            : await readLastPassingStageFingerprints(evidenceDir);
        const preparedStages = stages.map(stageDefinition => ({
            ...stageDefinition,
            dependsOn: [...(stageDefinition.dependsOn ?? [])],
            inputFingerprint: stageInputFingerprint(stageDefinition, changes),
        }));
        const runStage = async stageDefinition => {
            const cacheDecision = getValidationStageCacheDecision(stageDefinition, {
                changes,
                lastPassingFingerprints,
                noCache,
            });
            const {
                cacheHit,
                cacheReason,
                cacheState,
                inputFingerprint,
            } = cacheDecision;
            if (cacheHit) {
                const timestamp = new Date().toISOString();
                const result = {
                    cache: cacheState,
                    cacheHit: true,
                    cacheReason,
                    dependsOn: stageDefinition.dependsOn,
                    endedAt: timestamp,
                    id: stageDefinition.id,
                    inputFingerprint,
                    loadAverage: os.loadavg(),
                    skipped: true,
                    status: 'passed',
                    wallMs: 0,
                    weight: stageDefinition.weight ?? 1,
                };
                evidence.write(`${JSON.stringify({
                    cache: cacheState,
                    cacheHit: true,
                    cacheReason,
                    command: [
                        stageDefinition.command,
                        ...stageDefinition.args,
                    ],
                    dependsOn: stageDefinition.dependsOn,
                    event: 'stage-start',
                    heavyGateCoordinated: true,
                    heavyWeight: stageDefinition.heavyWeight,
                    id: stageDefinition.id,
                    inputFingerprint,
                    parallelPhase: stageDefinition.parallelPhase ?? null,
                    skipped: true,
                    startedAt: timestamp,
                    weight: stageDefinition.weight ?? 1,
                })}\n`);
                results.push(result);
                evidence.write(`${JSON.stringify({
                    event: 'stage-end',
                    ...result,
                })}\n`);
                process.stdout.write(`[gate] Cache hit: ${stageDefinition.id}\n`);
                return;
            }
            const gate = await acquireHeavyGate({
                id: stageDefinition.id,
                weight: stageDefinition.heavyWeight,
            });
            const startedAtMs = Date.now();
            evidence.write(`${JSON.stringify({
                cache: cacheState,
                cacheHit: false,
                cacheReason,
                command: [
                    stageDefinition.command,
                    ...stageDefinition.args,
                ],
                event: 'stage-start',
                heavyGateCoordinated: gate.coordinated,
                heavyWeight: stageDefinition.heavyWeight,
                id: stageDefinition.id,
                inputFingerprint,
                parallelPhase: stageDefinition.parallelPhase ?? null,
                startedAt: new Date(startedAtMs).toISOString(),
                dependsOn: stageDefinition.dependsOn,
                weight: stageDefinition.weight ?? 1,
            })}\n`);
            let status = 'passed';
            try {
                await spawnInherited(
                    stageDefinition.command,
                    stageDefinition.args,
                    {
                        ...process.env,
                        ...stageDefinition.env,
                        ...(noCache ? {EVB_GATE_NO_CACHE: '1'} : {}),
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
                    cacheHit: false,
                    cacheReason,
                    endedAt: new Date(endedAtMs).toISOString(),
                    dependsOn: stageDefinition.dependsOn,
                    id: stageDefinition.id,
                    inputFingerprint,
                    loadAverage: os.loadavg(),
                    skipped: false,
                    status,
                    wallMs: endedAtMs - startedAtMs,
                    weight: stageDefinition.weight ?? 1,
                };
                results.push(result);
                evidence.write(`${JSON.stringify({
                    event: 'stage-end',
                    ...result,
                })}\n`);
            }
        };
        await runStagePool(preparedStages, runStage, {capacity: parsePositiveInteger(process.env.EVB_GATE_CAPACITY, getDefaultGateCapacity())});
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
    const cold = argv.includes('--cold');
    const plan = getValidationPlan({
        allGates: process.env.EVB_VALIDATE_ALL_GATES === '1' || argv.includes('--all'),
        cold,
        changes,
        classification,
        tier,
    });
    const selectedPlan = selectValidationStages(plan, readArgs(argv, 'only'));
    process.stdout.write(`[gate] ${tier}: ${selectedPlan.map(item => item.id).join(', ') || 'no affected stages'}\n`);
    await runStages(selectedPlan, {
        changes: {
            ...changes,
            classification,
        },
        noCache: cold || argv.includes('--no-cache') || process.env.EVB_GATE_NO_CACHE === '1',
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
    )], {
        noCache: argv.includes('--cold')
            || argv.includes('--no-cache')
            || process.env.EVB_GATE_NO_CACHE === '1',
        tier: 'heavy',
    });
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
