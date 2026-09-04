import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    loadCapabilityRegistry,
    collectRegistryOracleIds,
} from '@scripts/windows-test/registry/capabilityRegistry';
import {
    createHumanReviewObligation,
    formatHumanReviewObligation,
    humanReviewOracleResult,
    HUMAN_REVIEW_ORACLE_ID,
} from '@scripts/windows-test/oracles/humanReviewObligation';
import {
    describeOracleProvenance,
    describeOracleProvenanceList,
    findOracleDescriptor,
    isKnownOracleId,
    unknownOracleIds,
    windowsGuestOracleIds,
    windowsHostOracleIds,
    windowsOracleDescriptors,
    windowsOracleIds,
} from '@scripts/windows-test/oracles/oracleRegistry';
import {
    combineOracleStatuses,
    createOracleResult,
    describeError,
} from '@scripts/windows-test/oracles/oracleResult';
import { resolvePdfjsAssetRoot } from '@scripts/windows-test/oracles/pdfjsNodeRuntime';
import {
    evaluateSourceIsolation,
    hashFile,
} from '@scripts/windows-test/oracles/sourceIsolationOracle';
import type { IVerifyProcessResult } from '@scripts/windows-test/oracles/verifyGeneratedPdfWrapper';
import {
    buildVerifyGeneratedPdfArgs,
    runVerifyGeneratedPdf,
} from '@scripts/windows-test/oracles/verifyGeneratedPdfWrapper';

const repositoryRoot = process.cwd();

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-windows-oracles-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});

function runnerReturning(result: Partial<IVerifyProcessResult>) {
    return () => Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        ...result,
    });
}

describe('oracleRegistry', () => {
    it('covers every oracle ID the capability registry references', async () => {
        const registry = await loadCapabilityRegistry(
            path.join(repositoryRoot, 'tests', 'windows', 'capabilities.json'),
        );
        expect(unknownOracleIds(collectRegistryOracleIds(registry))).toEqual([]);
    });

    it('records a version and provenance for every descriptor', () => {
        for (const descriptor of windowsOracleDescriptors) {
            expect(descriptor.id.length).toBeGreaterThan(0);
            expect(descriptor.version.length).toBeGreaterThan(0);
            expect(descriptor.provenance.length).toBeGreaterThan(0);
            expect(descriptor.description.length).toBeGreaterThan(0);
        }
        expect(new Set(windowsOracleIds).size).toBe(windowsOracleIds.length);
        expect(windowsOracleIds.length).toBe(windowsHostOracleIds.length + windowsGuestOracleIds.length);
    });

    it('separates host measurements from guest self-reports', () => {
        expect(windowsHostOracleIds).toContain('page-markers');
        expect(windowsGuestOracleIds).toContain('reopen');
        expect(findOracleDescriptor('page-markers')?.side).toBe('host');
        expect(findOracleDescriptor('reopen')?.side).toBe('guest');
        expect(findOracleDescriptor('telepathy')).toBeNull();
        expect(isKnownOracleId('render-nonblank')).toBe(true);
        expect(isKnownOracleId('telepathy')).toBe(false);
    });

    it('attaches provenance to a reported verdict and flags an unregistered oracle', () => {
        const record = describeOracleProvenance(createOracleResult({
            oracleId: 'page-count',
            oracleVersion: 'pdf-lib@1.17',
            status: 'passed',
            detail: 'ok',
        }));
        expect(record.side).toBe('host');
        expect(record.provenance).toContain('pdfStructureOracle');
        const unregistered = describeOracleProvenanceList([createOracleResult({
            oracleId: 'telepathy',
            oracleVersion: '0',
            status: 'passed',
            detail: 'ok',
        })]);
        expect(unregistered[0]?.side).toBe('unknown');
        expect(unregistered[0]?.provenance).toBe('unregistered oracle');
    });
});

describe('oracleResult helpers', () => {
    it('never promotes an inconclusive verdict to a pass', () => {
        expect(combineOracleStatuses([
            'passed',
            'passed',
        ])).toBe('passed');
        expect(combineOracleStatuses([
            'passed',
            'inconclusive',
        ])).toBe('inconclusive');
        expect(combineOracleStatuses([
            'inconclusive',
            'failed',
        ])).toBe('failed');
        expect(combineOracleStatuses([])).toBe('inconclusive');
    });

    it('describes both Error and non-Error failures', () => {
        expect(describeError(new Error('boom'))).toBe('boom');
        expect(describeError('boom')).toBe('boom');
    });
});

describe('humanReviewObligation', () => {
    it('produces a record that an automated run cannot close', () => {
        const obligation = createHumanReviewObligation({
            caseId: 'WIN-PRINT-01',
            environmentId: 'utm-win11-arm64-app-arm64',
            artifacts: ['contact-sheets/win-print-01.png'],
            question: 'Does the printed output match the source page?',
        });
        expect(obligation.reviewed).toBe(false);
        expect(obligation.verdict).toBeNull();
        expect(obligation.reviewerRole).toBe('desktop-test-engineer');
        const result = humanReviewOracleResult(obligation);
        expect(result.oracleId).toBe(HUMAN_REVIEW_ORACLE_ID);
        expect(result.status).toBe('inconclusive');
        expect(result.detail).toContain('WIN-PRINT-01');
        expect(formatHumanReviewObligation(obligation)).toContain('contact-sheets/win-print-01.png');
    });

    it('honours an explicit reviewer role', () => {
        const obligation = createHumanReviewObligation({
            caseId: 'WIN-UI-09',
            environmentId: 'physical-win-x64',
            artifacts: [],
            question: 'Is the high-contrast theme readable?',
            reviewerRole: 'accessibility-reviewer',
        });
        expect(obligation.reviewerRole).toBe('accessibility-reviewer');
    });
});

describe('sourceIsolationOracle', () => {
    it('passes when the source is untouched and the sidecar exists', async () => {
        const directory = await createTemporaryDirectory();
        const sourcePath = path.join(directory, 'source.pdf');
        await writeFile(sourcePath, 'original bytes');
        await writeFile(path.join(directory, 'source.pdf.evb.json'), '{}');
        const expectedSourceSha256 = await hashFile(sourcePath);
        const result = await evaluateSourceIsolation({
            sourcePath,
            workingDirectory: directory,
        }, {
            expectedSourceSha256,
            expectedSidecarFiles: ['source.pdf.evb.json'],
            forbiddenResidueFiles: ['source.pdf.tmp'],
        });
        expect(result.status).toBe('passed');
        expect(result.observations.presentSidecars).toEqual(['source.pdf.evb.json']);
    });

    it('fails when the source changed, a sidecar is missing or residue survived', async () => {
        const directory = await createTemporaryDirectory();
        const sourcePath = path.join(directory, 'source.pdf');
        await writeFile(sourcePath, 'mutated bytes');
        await writeFile(path.join(directory, 'source.pdf.tmp'), 'leftover');
        const result = await evaluateSourceIsolation({
            sourcePath,
            workingDirectory: directory,
        }, {
            expectedSourceSha256: createHash('sha256').update('original bytes').digest('hex'),
            expectedSidecarFiles: ['source.pdf.evb.json'],
            forbiddenResidueFiles: ['source.pdf.tmp'],
        });
        expect(result.status).toBe('failed');
        expect(result.detail).toContain('source hashes to');
        expect(result.detail).toContain('expected sidecar source.pdf.evb.json is missing');
        expect(result.detail).toContain('residue source.pdf.tmp survived');
    });

    it('fails when the source cannot be read at all', async () => {
        const directory = await createTemporaryDirectory();
        const result = await evaluateSourceIsolation({
            sourcePath: path.join(directory, 'absent.pdf'),
            workingDirectory: directory,
        }, { expectedSourceSha256: '0'.repeat(64) });
        expect(result.status).toBe('failed');
        expect(result.detail).toContain('could not be hashed');
    });

    it('treats a directory in the residue list as surviving residue', async () => {
        const directory = await createTemporaryDirectory();
        const sourcePath = path.join(directory, 'source.pdf');
        await writeFile(sourcePath, 'original bytes');
        await mkdir(path.join(directory, 'stale-journal'));
        const result = await evaluateSourceIsolation({
            sourcePath,
            workingDirectory: directory,
        }, {
            expectedSourceSha256: await hashFile(sourcePath),
            forbiddenResidueFiles: ['stale-journal'],
        });
        expect(result.status).toBe('failed');
        expect(result.observations.survivingResidue).toEqual(['stale-journal']);
    });
});

describe('verifyGeneratedPdfWrapper', () => {
    const options = {
        repositoryRoot,
        pdfPath: '/tmp/out.pdf',
        artifactDirectory: '/tmp/artifacts',
    };

    it('builds the documented CLI flags', () => {
        const args = buildVerifyGeneratedPdfArgs({
            ...options,
            pages: [
                1,
                2,
            ],
            dpi: 150,
            allowLarge: true,
            runner: runnerReturning({}),
        });
        expect(args[0]).toBe(path.join(repositoryRoot, 'scripts', 'diagnostics', 'verify-generated-pdf.py'));
        expect(args).toContain('--pdf=/tmp/out.pdf');
        expect(args).toContain('--artifact-dir=/tmp/artifacts');
        expect(args).toContain('--pages=1,2');
        expect(args).toContain('--dpi=150');
        expect(args).toContain('--allow-large');
    });

    it('omits the optional flags when they are not requested', () => {
        const args = buildVerifyGeneratedPdfArgs({
            ...options,
            pages: [],
            runner: runnerReturning({}),
        });
        expect(args.some(argument => argument.startsWith('--pages='))).toBe(false);
        expect(args.some(argument => argument.startsWith('--dpi='))).toBe(false);
        expect(args).not.toContain('--allow-large');
    });

    it('passes on a compatible classification', async () => {
        const result = await runVerifyGeneratedPdf({
            ...options,
            runner: runnerReturning({stdout: JSON.stringify({
                status: 'classified-compatible',
                pages: 1,
            })}),
        });
        expect(result.status).toBe('passed');
        expect(result.detail).toContain('classified-compatible');
    });

    it('fails on the verifier failure status', async () => {
        const result = await runVerifyGeneratedPdf({
            ...options,
            runner: runnerReturning({
                exitCode: 1,
                stdout: JSON.stringify({ status: 'failed' }),
            }),
        });
        expect(result.status).toBe('failed');
    });

    it('reports a missing python3 or Pillow as inconclusive, never a pass', async () => {
        const missingModule = await runVerifyGeneratedPdf({
            ...options,
            runner: runnerReturning({
                exitCode: 1,
                stderr: 'ModuleNotFoundError: No module named \'PIL\'',
            }),
        });
        expect(missingModule.status).toBe('inconclusive');
        const missingInterpreter = await runVerifyGeneratedPdf({
            ...options,
            runner: () => Promise.reject(new Error('spawn python3 ENOENT')),
        });
        expect(missingInterpreter.status).toBe('inconclusive');
        expect(missingInterpreter.detail).toContain('could not be started');
    });

    it('treats unparsable output as inconclusive on success and failed on error', async () => {
        const quiet = await runVerifyGeneratedPdf({
            ...options,
            runner: runnerReturning({ stdout: 'no json here' }),
        });
        expect(quiet.status).toBe('inconclusive');
        const noisy = await runVerifyGeneratedPdf({
            ...options,
            runner: runnerReturning({
                exitCode: 2,
                stdout: 'still no json',
                stderr: 'traceback',
            }),
        });
        expect(noisy.status).toBe('failed');
    });

    it('reads the report even when the script prints progress lines first', async () => {
        const result = await runVerifyGeneratedPdf({
            ...options,
            runner: runnerReturning({stdout: `rendering page 1\n${JSON.stringify({ status: 'requires-compatible-renderer' })}`}),
        });
        expect(result.status).toBe('passed');
    });
});

describe('pdfjsNodeRuntime', () => {
    it('resolves the tracked PDF.js asset root and rejects a wrong one', () => {
        expect(resolvePdfjsAssetRoot(repositoryRoot)).toBe(path.join(repositoryRoot, 'public', 'pdf'));
        expect(() => resolvePdfjsAssetRoot(tmpdir())).toThrow(/asset root is missing/u);
    });
});
