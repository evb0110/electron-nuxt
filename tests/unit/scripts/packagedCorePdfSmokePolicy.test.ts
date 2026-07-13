import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const smokeSource = readFileSync(
    resolve(process.cwd(), 'scripts/release/verifyPackagedCorePdfSmoke.ts'),
    'utf8',
);

describe('packaged core PDF smoke policy', () => {
    it('installs renderer callback compatibility before the journey starts', () => {
        expect(smokeSource.indexOf('await installPageEvaluationShims(page);')).toBeGreaterThan(-1);
        expect(smokeSource.indexOf('await installPageEvaluationShims(page);'))
            .toBeLessThan(smokeSource.indexOf('await openPdfInApp(page'));
    });

    it('uses persisted PDF bytes as the packaged save authority', () => {
        expect(smokeSource).not.toContain('waitForAutomationEvent(page, \'save-committed\'');
        expect(smokeSource).toContain('saveViaWindowHandle(page, OPERATION_TIMEOUT_MS)');
        expect(smokeSource).toContain('waitForSavedAnnotation(fixturePath, OPERATION_TIMEOUT_MS)');
        expect(smokeSource).toContain('readPdfAnnotationSummary(filePath)');
    });

    it('requests graceful app shutdown before falling back to process-tree cleanup', () => {
        const closeIndex = smokeSource.indexOf('await closeBrowserGracefully(browser);');
        const exitWaitIndex = smokeSource.indexOf('await waitForProcessExit(child.pid, 5_000);');
        const killIndex = smokeSource.indexOf('await killProcessTree(child.pid, 3_000);');
        const removeIndex = smokeSource.indexOf('await rm(workDirectory');
        expect(closeIndex).toBeGreaterThan(-1);
        expect(exitWaitIndex).toBeGreaterThan(closeIndex);
        expect(killIndex).toBeGreaterThan(exitWaitIndex);
        expect(killIndex).toBeGreaterThan(-1);
        expect(removeIndex).toBeGreaterThan(killIndex);
        expect(smokeSource).toContain('delay(SHUTDOWN_TIMEOUT_MS)');
        expect(smokeSource).toContain('if (isProcessAlive(child.pid))');
        expect(smokeSource).toContain('maxRetries: 10');
        expect(smokeSource).toContain('retryDelay: 200');
    });
});
