import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path, {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
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
    buildPrivateDeployArgs: (sourceRoot: string, rawArgs?: string[]) => string[];
    parsePrivateDeployOptions: (rawArgs?: string[]) => {
        deployArgs: string[];
        deployTarget: string;
    };
    promoteLandingVercelOutput: (projectRoot?: string) => void;
    preparePrivateDeploySource: (options?: {
        deployTarget?: string;
        projectRoot?: string;
    }) => IPreparedPrivateDeploySource;
}

const {
    buildPrivateDeployArgs,
    parsePrivateDeployOptions,
    promoteLandingVercelOutput,
    preparePrivateDeploySource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/deployVercelPrivate.mjs')).href
) as IPrivateDeployModule;

function createProjectFixture() {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-private-deploy-fixture-'));

    mkdirSync(path.join(projectRoot, '.git'), {recursive: true});
    mkdirSync(path.join(projectRoot, '.vercel'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'app'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'landing', '.vercel'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'landing', 'app'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'native'), {recursive: true});
    mkdirSync(path.join(projectRoot, 'packages', 'contracts'), {recursive: true});
    writeFileSync(path.join(projectRoot, '.git', 'config'), '[core]\n');
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

    return projectRoot;
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
});
