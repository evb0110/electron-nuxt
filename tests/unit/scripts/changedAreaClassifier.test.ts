import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    describe,
    expect,
    it,
} from 'vitest';

const classifierPath = resolve(process.cwd(), 'scripts/ci/classify-changed-areas.mjs');

interface IChangedAreaClassification { matched: boolean }

interface IChangedAreaDefinition {
    output: string;
    owner: string;
    paths: string[];
}

interface IChangedAreaClassifierModule { classifyChangedFiles: (files: string[]) => Record<string, IChangedAreaClassification> }

interface IReleasePolicyModule { getCiChangedAreaPolicy: () => Record<string, IChangedAreaDefinition> }

function runGit(cwd: string, args: string[]) {
    const result = spawnSync('git', [
        '-c',
        'commit.gpgSign=false',
        ...args,
    ], {
        cwd,
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
}

function createTempRepository() {
    const root = mkdtempSync(join(tmpdir(), 'evb-changed-areas-git-'));
    runGit(root, [
        'init',
        '--quiet',
    ]);
    runGit(root, [
        'config',
        'user.email',
        'classifier@example.test',
    ]);
    runGit(root, [
        'config',
        'user.name',
        'Changed Area Classifier',
    ]);
    return root;
}

function commitAll(root: string, message: string) {
    runGit(root, [
        'add',
        '--all',
    ]);
    runGit(root, [
        'commit',
        '--quiet',
        '-m',
        message,
    ]);
    return runGit(root, [
        'rev-parse',
        'HEAD',
    ]);
}

function runClassifierForRange(root: string, base: string, head: string) {
    const result = spawnSync(process.execPath, [
        classifierPath,
        `--base=${base}`,
        `--head=${head}`,
    ], {
        cwd: root,
        encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
        files: string[];
        result: Record<string, IChangedAreaClassification>;
    };
}

const { classifyChangedFiles } = await import(
    pathToFileURL(classifierPath).href
) as IChangedAreaClassifierModule;
const { getCiChangedAreaPolicy } = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href
) as IReleasePolicyModule;

describe('changed-area classifier', () => {
    it('classifies release-critical hooks, workflows, resources, and landing sources', () => {
        for (const file of [
            '.github/workflows/build.yml',
            'native/pdf-search/Cargo.toml',
            'resources/tesseract/tessdata/eng.traineddata',
            'scripts/afterPack.cjs',
            'scripts/afterSign.cjs',
            'scripts/build-minimal-ffmpeg-for-unpaper.sh',
            'scripts/cargo-artifacts.mjs',
            'scripts/checkSearchNativeParity.ts',
            'scripts/ci/classify-changed-areas.mjs',
            'scripts/generate-djvu-fidelity-corpus.mjs',
            'scripts/nativeResourceManifest.ts',
            'scripts/test-ocr-native-smoke.mjs',
            'scripts/verify-packaged-startup.sh',
        ]) {
            expect(classifyChangedFiles([file]).native_or_build?.matched, file).toBe(true);
        }
        expect(classifyChangedFiles(['landing/app/pages/index.vue']).landing?.matched).toBe(true);
        expect(classifyChangedFiles(['packages/release-selection/index.ts']).landing?.matched).toBe(true);
        expect(classifyChangedFiles(['scripts/ci/classify-changed-areas.mjs']).landing?.matched).toBe(true);
        expect(classifyChangedFiles(['app/modules/pdf-viewer/PdfViewer.vue']).electron_smoke?.matched).toBe(true);
        expect(classifyChangedFiles(['scripts/electron-run/electronLaunch.ts']).electron_smoke?.matched).toBe(true);
        expect(classifyChangedFiles(['app/platform/browser/browserDocumentIdb.ts']).browser_integration?.matched).toBe(true);
        expect(classifyChangedFiles(['app/app.vue'])).toMatchObject({
            landing: { matched: false },
            native_or_build: { matched: false },
        });
    });

    it('keeps workflow outputs and job owners aligned with the canonical policy', () => {
        const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
        const changedAreaJob = workflow.slice(
            workflow.indexOf('  pr_changed_areas:'),
            workflow.indexOf('  pr_native_build_safety:'),
        );

        for (const definition of Object.values(getCiChangedAreaPolicy())) {
            expect(changedAreaJob).toContain(`${definition.output}: \${{ steps.classify.outputs.${definition.output} }}`);
            expect(workflow).toContain(`  ${definition.owner}:`);
            for (const pattern of definition.paths) {
                if (pattern === 'scripts/ci/classify-changed-areas.mjs') {
                    continue;
                }
                expect(changedAreaJob).not.toContain(pattern);
            }
        }
    });

    it('writes executable GitHub outputs from the canonical policy', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'evb-changed-areas-'));
        const outputPath = join(tempDir, 'github-output');
        try {
            const result = spawnSync(process.execPath, [
                classifierPath,
                '--file=scripts/afterPack.cjs',
                '--file=landing/app/pages/index.vue',
            ], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_OUTPUT: outputPath,
                },
            });

            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(outputPath, 'utf8').trim().split('\n').sort()).toEqual([
                'browser_integration=false',
                'electron_smoke=false',
                'landing=true',
                'native_or_build=true',
            ]);
        } finally {
            rmSync(tempDir, {
                force: true,
                recursive: true,
            });
        }
    });

    it('classifies deletion of a landing source from an executable git diff', () => {
        const root = createTempRepository();
        try {
            const landingPage = join(root, 'landing/app/pages/removed.vue');
            mkdirSync(resolve(landingPage, '..'), {recursive: true});
            writeFileSync(landingPage, '<template />\n', 'utf8');
            const base = commitAll(root, 'add landing page');
            rmSync(landingPage);
            const head = commitAll(root, 'delete landing page');

            const classification = runClassifierForRange(root, base, head);

            expect(classification.files).toContain('landing/app/pages/removed.vue');
            expect(classification.result.landing?.matched).toBe(true);
        } finally {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('classifies a rename out of a relevant area as delete plus add', () => {
        const root = createTempRepository();
        try {
            const source = join(root, 'landing/app/pages/moved.vue');
            const destination = join(root, 'notes/moved.vue');
            mkdirSync(resolve(source, '..'), {recursive: true});
            writeFileSync(source, '<template />\n', 'utf8');
            const base = commitAll(root, 'add landing page');
            mkdirSync(resolve(destination, '..'), {recursive: true});
            runGit(root, [
                'mv',
                'landing/app/pages/moved.vue',
                'notes/moved.vue',
            ]);
            const head = commitAll(root, 'move landing page out');

            const classification = runClassifierForRange(root, base, head);

            expect(classification.files).toEqual(expect.arrayContaining([
                'landing/app/pages/moved.vue',
                'notes/moved.vue',
            ]));
            expect(classification.result.landing?.matched).toBe(true);
        } finally {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
