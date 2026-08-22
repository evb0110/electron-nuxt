import {readFile} from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readSource(path: string) {
    return readFile(path, 'utf8');
}

function guardedSourceSlice(
    source: string,
    startMarker: string,
    endMarker: string,
    label: string,
) {
    const start = source.indexOf(startMarker);
    expect(start, `${label} start marker`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end, `${label} end marker`).toBeGreaterThan(start);
    return {
        end,
        source: source.slice(start, end),
        start,
    };
}

describe('Electron E2E retry classification policy', () => {
    it('keeps retries CI-only and tied to the infrastructure marker', async () => {
        const config = await readSource('vitest.shared.config.ts');
        const projectFactory = guardedSourceSlice(
            config,
            'function createElectronE2ETestProject',
            '\nexport const vitestProjects',
            'Electron E2E project factory',
        ).source;

        expect(projectFactory).toMatch(
            /retry:\s*process\.env\.CI\s*\?\s*\{\s*condition:\s*\/\\\[INFRA\\\]\/u,\s*count:\s*2,\s*\}\s*:\s*0,/u,
        );
    });

    it('keeps renderer and application readiness outside infrastructure classification', async () => {
        const fixture = await readSource('tests/e2e/electron/helpers/createElectronE2ESessionFixture.ts');
        const failureClassification = await readSource(
            'tests/e2e/electron/helpers/electronE2ESessionFailure.ts',
        );
        const session = await readSource('tests/e2e/electron/helpers/startElectronE2ESession.ts');
        const connectBlock = guardedSourceSlice(
            session,
            'async function connectToSessionPage',
            '\nexport async function startElectronE2ESession',
            'CDP connection block',
        );
        const startBlock = session.slice(connectBlock.end);
        const healthBlock = guardedSourceSlice(
            session,
            'async function waitForHealthReady',
            '\nasync function waitForPageTarget',
            'health readiness block',
        ).source;

        expect(fixture).toContain('formatElectronE2ESessionFailure');
        expect(fixture).not.toContain('function createInfraError');
        expect(connectBlock.source).toContain('\'cdp-connection\'');
        expect(connectBlock.source).not.toContain('waitForRendererReady');
        expect(connectBlock.source).not.toContain('installPageEvaluationShims');
        expect(startBlock).toContain('await installPageEvaluationShims(page);');
        expect(startBlock).toContain('await waitForRendererReady(page);');
        expect(failureClassification).toContain('\'process-launch\'');
        expect(startBlock).toContain('runElectronE2EProcessLaunchStage(');
        expect(startBlock).not.toMatch(
            /runElectronE2EInfrastructureStage\s*\(\s*['"]process-launch['"]/u,
        );
        expect(failureClassification).toContain('\'transport\'');
        expect(session).toContain('\'session-runner\'');
        expect(session).toContain('state.bodyText.includes(\'Internal Server Error\')');
        expect(healthBlock).toContain('successfulResponseCount += 1;');
        expect(healthBlock).toContain('createElectronE2EHealthReadinessFailure(');
        expect(healthBlock).not.toContain('runElectronE2EInfrastructureStage(');
    });
});
