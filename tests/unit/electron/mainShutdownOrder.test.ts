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
});
