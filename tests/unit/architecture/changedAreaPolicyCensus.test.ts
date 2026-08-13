import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IChangedAreaDefinition {paths: string[];}

interface IReleasePolicyModule {
    getCiChangedAreaPolicy: () => Record<string, IChangedAreaDefinition>;
    getValidationImpactPolicy: () => Record<string, IChangedAreaDefinition>;
}

interface IChangedAreaClassification {matched: boolean;}

interface IChangedAreaClassifierModule {classifyChangedFiles: (files: string[]) => Record<string, IChangedAreaClassification>;}

const {
    getCiChangedAreaPolicy,
    getValidationImpactPolicy,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href
) as IReleasePolicyModule;
const {classifyChangedFiles} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/ci/classify-changed-areas.mjs')).href
) as IChangedAreaClassifierModule;

async function listTrackedTopLevelDirectories() {
    const trackedPaths = await new Promise<string>((resolvePaths, reject) => {
        const child = spawn('git', [
            'ls-files',
            '-z',
        ], {
            cwd: process.cwd(),
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        const stdout: string[] = [];
        const stderr: string[] = [];
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolvePaths(stdout.join(''));
                return;
            }
            reject(new Error(`git ls-files failed with code ${code}: ${stderr.join('').trim()}`));
        });
    });

    return [...new Set(trackedPaths
        .split('\0')
        .filter(filePath => filePath.includes('/'))
        .map(filePath => filePath.slice(0, filePath.indexOf('/'))))]
        .sort();
}

describe('changed-area policy source census', () => {
    it('maps every tracked top-level directory into at least one area or impact', async () => {
        const sourceDirectories = await listTrackedTopLevelDirectories();
        const policyPatterns = [
            ...Object.values(getCiChangedAreaPolicy()),
            ...Object.values(getValidationImpactPolicy()),
        ]
            .flatMap(definition => definition.paths);
        const unmappedDirectories = sourceDirectories.filter(directory => (
            !policyPatterns.some(pattern => pattern.startsWith(`${directory}/`))
        ));

        expect(unmappedDirectories).toEqual([]);
    });

    it('routes scan-cleanup and local-action changes through their blocking gates', () => {
        expect(classifyChangedFiles(['scan-cleanup-core/provenanceStamp.ts']).electron_smoke?.matched)
            .toBe(true);
        expect(classifyChangedFiles(['scan-cleanup-adapters/createScanCleanupAdapter.ts']).electron_smoke?.matched)
            .toBe(true);
        expect(classifyChangedFiles(['.github/actions/example/action.yml']).native_or_build?.matched)
            .toBe(true);
    });
});
