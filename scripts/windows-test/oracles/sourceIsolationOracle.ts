import { createHash } from 'node:crypto';
import {
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import {
    createOracleResult,
    describeError,
} from '@scripts/windows-test/oracles/oracleResult';

export const SOURCE_ISOLATION_ORACLE_ID = 'source-isolation';

export const SOURCE_ISOLATION_ORACLE_VERSION = 'node-crypto-sha256';

export interface ISourceIsolationExpectation {
    /** The source hash captured before the operation under test. */
    expectedSourceSha256: string;
    /** Sidecar or journal files that must exist when the operation settles. */
    expectedSidecarFiles?: readonly string[];
    /** Working copies, journals and temp files that must not survive. */
    forbiddenResidueFiles?: readonly string[];
}

export interface ISourceIsolationInput {
    sourcePath: string;
    workingDirectory: string;
}

export async function hashFile(filePath: string) {
    const bytes = await readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function evaluateSourceIsolation(
    input: ISourceIsolationInput,
    expectation: ISourceIsolationExpectation,
): Promise<IOracleResult> {
    const failures: string[] = [];
    let actualSourceSha256: string | null = null;
    try {
        actualSourceSha256 = await hashFile(input.sourcePath);
    } catch (error) {
        return createOracleResult({
            oracleId: SOURCE_ISOLATION_ORACLE_ID,
            oracleVersion: SOURCE_ISOLATION_ORACLE_VERSION,
            status: 'failed',
            detail: `The source could not be hashed: ${describeError(error)}`,
            observations: { sourcePath: input.sourcePath },
        });
    }
    if (actualSourceSha256 !== expectation.expectedSourceSha256) {
        failures.push(
            `source hashes to ${actualSourceSha256}, expected ${expectation.expectedSourceSha256}`,
        );
    }
    const presentSidecars: string[] = [];
    for (const sidecar of expectation.expectedSidecarFiles ?? []) {
        const absolute = path.resolve(input.workingDirectory, sidecar);
        if (await pathExists(absolute)) {
            presentSidecars.push(sidecar);
            continue;
        }
        failures.push(`expected sidecar ${sidecar} is missing`);
    }
    const survivingResidue: string[] = [];
    for (const residue of expectation.forbiddenResidueFiles ?? []) {
        const absolute = path.resolve(input.workingDirectory, residue);
        if (await pathExists(absolute)) {
            survivingResidue.push(residue);
            failures.push(`residue ${residue} survived the operation`);
        }
    }
    return createOracleResult({
        oracleId: SOURCE_ISOLATION_ORACLE_ID,
        oracleVersion: SOURCE_ISOLATION_ORACLE_VERSION,
        status: failures.length === 0 ? 'passed' : 'failed',
        detail: failures.length === 0
            ? 'The source hash is unchanged and the sidecar and residue expectations hold.'
            : failures.join('; '),
        observations: {
            actualSourceSha256,
            presentSidecars,
            survivingResidue,
        },
    });
}
