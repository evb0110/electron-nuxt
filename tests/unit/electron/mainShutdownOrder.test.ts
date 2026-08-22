import { readFileSync } from 'fs';
import { join } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('main shutdown ordering', () => {
    it('requests renderer save flush before closing main operation admission', () => {
        const source = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');
        const flushStepIndex = source.indexOf('label: \'renderer-save-flush\'');
        const shutdownStepIndex = source.indexOf('label: \'main-operation-shutdown\'');
        const beginShutdownIndex = source.indexOf(
            'beginMainOperationShutdown(\'Main process is shutting down\')',
            shutdownStepIndex,
        );

        expect(flushStepIndex).toBeGreaterThan(-1);
        expect(shutdownStepIndex).toBeGreaterThan(flushStepIndex);
        expect(beginShutdownIndex).toBeGreaterThan(shutdownStepIndex);
    });

    it('settles cancelled materialization flights before closing read handles or deleting working copies', () => {
        const source = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');
        const cancelIndex = source.indexOf('cancelAllMainOperations(\'app shutdown\')');
        const materializationIndex = source.indexOf('label: \'working-copy-materializations\'');
        const settleIndex = source.indexOf(
            'settleAllWorkingCopyMaterializations()',
            materializationIndex,
        );
        const rangeHandleIndex = source.indexOf('label: \'range-read-handles\'');
        const cleanupIndex = source.indexOf('label: \'working-copies\'');

        expect(cancelIndex).toBeGreaterThan(-1);
        expect(materializationIndex).toBeGreaterThan(cancelIndex);
        expect(settleIndex).toBeGreaterThan(materializationIndex);
        expect(rangeHandleIndex).toBeGreaterThan(settleIndex);
        expect(cleanupIndex).toBeGreaterThan(rangeHandleIndex);
    });

    it('installs fatal process handlers only after shutdown coordination is ready', () => {
        const source = readFileSync(join(process.cwd(), 'electron/main.ts'), 'utf8');
        const coordinatorIndex = source.indexOf('shutdownCoordinator = createShutdownCoordinator({');
        const rejectionHandlerIndex = source.indexOf(
            'process.on(\'unhandledRejection\', (reason) => {',
        );
        const exceptionHandlerIndex = source.indexOf('process.on(\'uncaughtException\'');

        expect(coordinatorIndex).toBeGreaterThan(-1);
        expect(rejectionHandlerIndex).toBeGreaterThan(-1);
        expect(exceptionHandlerIndex).toBeGreaterThan(-1);
        expect(rejectionHandlerIndex).toBeGreaterThan(coordinatorIndex);
        expect(exceptionHandlerIndex).toBeGreaterThan(rejectionHandlerIndex);

        const rejectionHandler = source.slice(rejectionHandlerIndex, exceptionHandlerIndex);
        expect(rejectionHandler).toMatch(/decideUnhandledRejection\s*\(\s*reason\s*\)/u);
        expect(rejectionHandler).toMatch(
            /requestFatalShutdown\s*\(\s*['"]Unhandled promise rejection requires fatal shutdown['"]\s*\)/u,
        );
        expect(rejectionHandler).toMatch(
            /onError\s*:\s*\(?error\)?\s*=>\s*requestFatalShutdown\s*\(/u,
        );
        expect(rejectionHandler).toMatch(
            /Unhandled rejection subsystem recovery failed[^`]*\$\{decision\.subsystem\}[^`]*\$\{getErrorMessage\(error\)\}/u,
        );
    });
});
