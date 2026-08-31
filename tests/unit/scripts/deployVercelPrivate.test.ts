import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path, {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IPreparedPrivateDeploySource {
    cleanup: () => void;
    scratchRoot: string;
    sourceRoot: string;
}

interface IPrivateDeployModule {
    buildVercelRollbackArgs: (deploymentUrl: string) => string[];
    buildPrivateDeployArgs: (sourceRoot: string, rawArgs?: string[]) => string[];
    extractVercelDeploymentUrl: (output: string) => string | null;
    parsePrivateDeployOptions: (rawArgs?: string[]) => {
        deployArgs: string[];
        deployTarget: string;
    };
    promoteLandingVercelOutput: (projectRoot?: string) => void;
    preparePrivateDeploySource: (options?: {
        deployTarget?: string;
        projectRoot?: string;
    }) => IPreparedPrivateDeploySource;
    quoteWindowsShellArg: (arg: string) => string;
    runPrivateVercelDeploy: (options?: Record<string, unknown>) => Promise<number>;
}

const {
    buildVercelRollbackArgs,
    buildPrivateDeployArgs,
    extractVercelDeploymentUrl,
    parsePrivateDeployOptions,
    promoteLandingVercelOutput,
    preparePrivateDeploySource,
    quoteWindowsShellArg,
    runPrivateVercelDeploy,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/deployVercelPrivate.mjs')).href
) as IPrivateDeployModule;

function createProjectFixture() {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-private-deploy-fixture-'));

    mkdirSync(path.join(projectRoot, '.vercel'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'app'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'landing', '.vercel'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'landing', 'app'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'native'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'packages', 'contracts'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'scripts', 'lib'), {recursive: true});
    writeFileSync(path.join(projectRoot, '.gitignore'), '.vercel/\n.env.local\n.devkit/\nMEMORIES.md\n');
    writeFileSync(path.join(projectRoot, '.env.local'), 'SECRET=value\n');
    writeFileSync(path.join(projectRoot, '.env.example'), 'SAFE=value\n');
    writeFileSync(path.join(projectRoot, '.vercel', 'project.json'), '{"projectId":"project"}\n');
    writeFileSync(
        path.join(projectRoot, 'package.json'),
        '{"name":"fixture","scripts":{"build":"viewer-build"}}\n',
    );
    writeFileSync(path.join(projectRoot, 'app', 'index.ts'), 'export const app = true;\n');
    writeFileSync(
        path.join(projectRoot, 'landing', '.vercel', 'project.json'),
        '{"projectId":"landing-project"}\n',
    );
    writeFileSync(path.join(projectRoot, 'landing', 'app', 'index.ts'), 'export const landing = true;\n');
    writeFileSync(path.join(projectRoot, 'landing', 'package.json'), '{"name":"landing"}\n');
    writeFileSync(path.join(projectRoot, 'native', 'binary'), 'local-only\n');
    writeFileSync(
        path.join(projectRoot, 'packages', 'contracts', 'index.ts'),
        'export const contract = true;\n',
    );
    writeFileSync(
        path.join(projectRoot, 'scripts', 'check-electron-install.mjs'),
        'import {getCliErrorMessage} from \'./lib/cli-error.mjs\';\n',
    );
    writeFileSync(
        path.join(projectRoot, 'scripts', 'lib', 'cli-error.mjs'),
        'export const getCliErrorMessage = String;\n',
    );
    writeFileSync(
        path.join(projectRoot, 'pnpm-workspace.yaml'),
        [
            'packages:',
            '  - \'.\'',
            '  - \'landing\'',
            '  - \'packages/*\'',
            '',
            'ignoredBuiltDependencies:',
            '  - \'@parcel/watcher\'',
            '',
        ].join('\n'),
    );
    writeFileSync(path.join(projectRoot, '.vercelignore'), 'native/\napp/keep.txt\n# comment\n');

    execFileSync('git', [
        'init',
        '--quiet',
    ], {cwd: projectRoot});
    execFileSync('git', [
        'config',
        'user.email',
        'deploy-test@example.test',
    ], {cwd: projectRoot});
    execFileSync('git', [
        'config',
        'user.name',
        'Deploy Test',
    ], {cwd: projectRoot});
    execFileSync('git', [
        'add',
        '--all',
    ], {cwd: projectRoot});
    execFileSync('git', [
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture',
    ], {cwd: projectRoot});

    return projectRoot;
}

function commitFixtureChanges(projectRoot: string) {
    execFileSync('git', [
        'add',
        '--all',
    ], {cwd: projectRoot});
    execFileSync('git', [
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture update',
    ], {cwd: projectRoot});
}

describe('private Vercel deployment source', () => {
    it('removes Git identity and local secrets while preserving project linkage', () => {
        const projectRoot = createProjectFixture();
        let prepared: IPreparedPrivateDeploySource | undefined;

        try {
            prepared = preparePrivateDeploySource({projectRoot});

            expect(existsSync(path.join(prepared.sourceRoot, '.git'))).toBe(false);
            expect(existsSync(path.join(prepared.sourceRoot, '.env.local'))).toBe(false);
            expect(existsSync(path.join(prepared.sourceRoot, 'landing'))).toBe(false);
            expect(existsSync(path.join(prepared.sourceRoot, 'native'))).toBe(false);
            expect(existsSync(path.join(prepared.sourceRoot, '.env.example'))).toBe(true);
            expect(existsSync(path.join(prepared.sourceRoot, 'app', 'index.ts'))).toBe(true);
            expect(existsSync(
                path.join(prepared.sourceRoot, 'packages', 'contracts', 'index.ts'),
            )).toBe(true);
            const electronInstallCheckPath = path.join(
                prepared.sourceRoot,
                'scripts',
                'check-electron-install.mjs',
            );
            const electronInstallCheck = readFileSync(electronInstallCheckPath, 'utf8');
            const importedRelativePath = electronInstallCheck.match(/from '([^']+)'/u)?.[1];

            expect(importedRelativePath).toBe('./lib/cli-error.mjs');
            expect(existsSync(path.join(
                prepared.sourceRoot,
                'scripts',
                'lib',
                'cli-error.mjs',
            ))).toBe(true);
            expect(readFileSync(
                path.join(prepared.sourceRoot, 'pnpm-workspace.yaml'),
                'utf8',
            )).toBe([
                'packages:',
                '  - \'.\'',
                '  - \'packages/*\'',
                '',
                'ignoredBuiltDependencies:',
                '  - \'@parcel/watcher\'',
                '',
            ].join('\n'));
            expect(readFileSync(
                path.join(prepared.sourceRoot, '.vercel', 'project.json'),
                'utf8',
            )).toContain('projectId');
            expect(readFileSync(path.join(prepared.sourceRoot, '.vercelignore'), 'utf8'))
                .toBe('app/keep.txt\n# comment\n');
        } finally {
            prepared?.cleanup();
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    // The copy filter shares its entry predicate with check-web-deploy-source.mjs,
    // so a case variant an editor produced is excluded here exactly as it is from
    // the measured deploy source.
    it('never copies local-only artifacts in any case, while near misses ship', () => {
        const projectRoot = createProjectFixture();
        let prepared: IPreparedPrivateDeploySource | undefined;

        try {
            mkdirSync(path.join(projectRoot, '.devkit', 'plans'), {recursive: true});
            writeFileSync(path.join(projectRoot, '.devkit', 'plans', 'ledger.md'), '# local\n');
            writeFileSync(path.join(projectRoot, 'AGENTS.MD'), '# instructions\n');
            writeFileSync(path.join(projectRoot, 'Claude.Md'), '# instructions\n');
            writeFileSync(path.join(projectRoot, 'app', 'gemini.md'), '# instructions\n');
            writeFileSync(path.join(projectRoot, 'app', 'MEMORIES.md'), '# local scratch\n');
            writeFileSync(path.join(projectRoot, 'AGENTS.mdx'), '# ordinary document\n');
            writeFileSync(path.join(projectRoot, 'app', 'memories-overview.md'), '# ordinary document\n');
            commitFixtureChanges(projectRoot);

            prepared = preparePrivateDeploySource({projectRoot});

            for (const relativePath of [
                '.devkit',
                'AGENTS.MD',
                'Claude.Md',
                path.join('app', 'gemini.md'),
                path.join('app', 'MEMORIES.md'),
            ]) {
                expect(existsSync(path.join(prepared.sourceRoot, relativePath))).toBe(false);
            }
            for (const relativePath of [
                'AGENTS.mdx',
                path.join('app', 'memories-overview.md'),
            ]) {
                expect(existsSync(path.join(prepared.sourceRoot, relativePath))).toBe(true);
            }
        } finally {
            prepared?.cleanup();
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('refuses to deploy an uncommitted tracked-source snapshot', () => {
        const projectRoot = createProjectFixture();

        try {
            writeFileSync(path.join(projectRoot, 'app', 'unreviewed.ts'), 'export const unsafe = true;\n');
            expect(() => preparePrivateDeploySource({projectRoot})).toThrow(
                'Web deploy source must be a clean tracked Git snapshot',
            );
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('uses archive uploads and non-interactive confirmation by default', () => {
        expect(buildPrivateDeployArgs('/tmp/source', [
            '--prod',
            '--logs',
        ])).toEqual([
            'deploy',
            '/tmp/source',
            '--yes',
            '--archive=tgz',
            '--prod',
            '--logs',
        ]);
        expect(buildPrivateDeployArgs('/tmp/source', [
            '--yes',
            '--archive=zip',
        ])).toEqual([
            'deploy',
            '/tmp/source',
            '--yes',
            '--archive=zip',
        ]);
    });

    it('requires a reported deployment URL and rolls back a failed production acceptance', async () => {
        const projectRoot = createProjectFixture();
        const calls: Array<{
            args: string[];
            command: string
        }> = [];

        try {
            await expect(runPrivateVercelDeploy({
                command: 'vercel-test',
                env: {CI: 'true'},
                fetchImpl: async () => ({
                    ok: false,
                    status: 503,
                }),
                projectRoot,
                rawArgs: ['--prod'],
                spawnSyncImpl: (command: string, args: string[]) => {
                    calls.push({
                        args,
                        command,
                    });
                    return calls.length === 1
                        ? {
                            stderr: '',
                            stdout: 'Production: https://evb-viewer-test.vercel.app\n',
                            status: 0,
                        }
                        : {status: 0};
                },
            })).rejects.toThrow('The failed deployment was rolled back.');

            expect(calls.map(call => call.args)).toEqual([
                expect.arrayContaining(['deploy']),
                [
                    'rollback',
                    'https://evb-viewer-test.vercel.app',
                    '--yes',
                ],
            ]);
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('extracts deployment URLs and builds an explicit rollback command', () => {
        expect(extractVercelDeploymentUrl('ready at https://viewer-abc.vercel.app')).toBe(
            'https://viewer-abc.vercel.app',
        );
        expect(buildVercelRollbackArgs('https://viewer-abc.vercel.app')).toEqual([
            'rollback',
            'https://viewer-abc.vercel.app',
            '--yes',
        ]);
        expect(() => buildVercelRollbackArgs('')).toThrow('deployment URL is required');
    });

    it('preserves the landing workspace and uses its separate project linkage', () => {
        const projectRoot = createProjectFixture();
        let prepared: IPreparedPrivateDeploySource | undefined;

        try {
            prepared = preparePrivateDeploySource({
                deployTarget: 'landing',
                projectRoot,
            });

            expect(existsSync(path.join(prepared.sourceRoot, 'landing', 'app', 'index.ts')))
                .toBe(true);
            expect(existsSync(path.join(prepared.sourceRoot, 'native'))).toBe(false);
            expect(readFileSync(
                path.join(prepared.sourceRoot, 'pnpm-workspace.yaml'),
                'utf8',
            )).toContain('  - \'landing\'');
            expect(readFileSync(
                path.join(prepared.sourceRoot, '.vercel', 'project.json'),
                'utf8',
            )).toContain('landing-project');
            expect(readFileSync(path.join(prepared.sourceRoot, '.vercelignore'), 'utf8'))
                .not.toContain('landing/');
            expect(JSON.parse(readFileSync(
                path.join(prepared.sourceRoot, 'package.json'),
                'utf8',
            )).scripts.build).toBe(
                'pnpm --dir landing run build'
                + ' && node scripts/deployVercelPrivate.mjs --promote-landing-output',
            );
        } finally {
            prepared?.cleanup();
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('promotes the landing Build Output API directory to the deployment root', () => {
        const projectRoot = createProjectFixture();

        try {
            const landingOutputRoot = path.join(projectRoot, 'landing', '.vercel', 'output');

            mkdirSync(path.join(landingOutputRoot, 'static'), {recursive: true});
            writeFileSync(path.join(landingOutputRoot, 'config.json'), '{"version":3}\n');
            writeFileSync(path.join(landingOutputRoot, 'static', 'index.html'), 'landing\n');
            mkdirSync(path.join(landingOutputRoot, 'functions'), {recursive: true});
            symlinkSync(
                './__fallback.func',
                path.join(landingOutputRoot, 'functions', 'index-isr.func'),
            );
            mkdirSync(path.join(projectRoot, '.vercel', 'output'), {recursive: true});
            writeFileSync(path.join(projectRoot, '.vercel', 'output', 'stale.txt'), 'stale\n');

            promoteLandingVercelOutput(projectRoot);

            expect(readFileSync(
                path.join(projectRoot, '.vercel', 'output', 'config.json'),
                'utf8',
            )).toBe('{"version":3}\n');
            expect(readFileSync(
                path.join(projectRoot, '.vercel', 'output', 'static', 'index.html'),
                'utf8',
            )).toBe('landing\n');
            expect(existsSync(
                path.join(projectRoot, '.vercel', 'output', 'stale.txt'),
            )).toBe(false);
            expect(readlinkSync(
                path.join(projectRoot, '.vercel', 'output', 'functions', 'index-isr.func'),
            )).toBe('./__fallback.func');
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps the deploy target selector out of Vercel arguments', () => {
        expect(parsePrivateDeployOptions([
            '--target=landing',
            '--prod',
            '--logs',
        ])).toEqual({
            deployArgs: [
                '--prod',
                '--logs',
            ],
            deployTarget: 'landing',
        });
        expect(() => parsePrivateDeployOptions(['--target=unknown']))
            .toThrow('Unsupported deploy target: unknown');
    });

    describe('quoteWindowsShellArg', () => {
        it('wraps every argument so cmd metacharacters stay literal', () => {
            // A cmd metacharacter with no surrounding whitespace (e.g. an "A&B"
            // Windows account name in a scratch path) must not leak out of the
            // argument and run as a separate command.
            expect(quoteWindowsShellArg('C:\\Users\\A&B\\AppData\\Local\\Temp\\evb'))
                .toBe('"C:\\Users\\A&B\\AppData\\Local\\Temp\\evb"');
            expect(quoteWindowsShellArg('a^b|c(d)e<f>g')).toBe('"a^b|c(d)e<f>g"');
        });

        it('quotes plain arguments and paths with spaces', () => {
            expect(quoteWindowsShellArg('deploy')).toBe('"deploy"');
            expect(quoteWindowsShellArg('--archive=tgz')).toBe('"--archive=tgz"');
            expect(quoteWindowsShellArg('C:\\Users\\First Last\\Temp'))
                .toBe('"C:\\Users\\First Last\\Temp"');
        });

        it('escapes embedded double quotes', () => {
            expect(quoteWindowsShellArg('a"b')).toBe('"a\\"b"');
        });
    });
});
