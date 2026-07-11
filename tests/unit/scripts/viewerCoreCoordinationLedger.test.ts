import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('viewer-core coordination primitive ledger', () => {
    it('keeps the audited Stage 0 baseline explicit and machine countable', async () => {
        const ledger = JSON.parse(await readFile(resolve(
            process.cwd(),
            'docs/architecture/viewer-core-coordination-primitives.json',
        ), 'utf8')) as {
            finalTargetExclusive: number;
            stages: Array<{
                categories: Record<string, string[]>;
                stage: number
            }>;
        };
        const baseline = ledger.stages[0]!;
        const counts = Object.fromEntries(Object.entries(baseline.categories)
            .map(([
                category,
                identifiers,
            ]) => [
                category,
                identifiers.length,
            ]));
        expect(baseline.stage).toBe(0);
        expect(counts).toEqual({
            timers: 27,
            locks: 8,
            counters: 15,
        });
        expect(ledger.finalTargetExclusive).toBe(10);
    });
});
