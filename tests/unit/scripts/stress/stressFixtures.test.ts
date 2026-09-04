import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    STRESS_FIXTURE_IDS,
    STRESS_FIXTURE_SPECS,
    computeStressFixtureSpecHash,
    describeStressFixtures,
    isStressFixtureId,
    isStressFixtureRecordReusable,
    parseStressFixtureManifest,
} from '@scripts/stress/stressFixtures';
import type { IStressFixtureRecord } from '@scripts/stress/stressFixtures';
import { STRESS_SCENARIOS } from '@scripts/stress/stressScenarioRegistry';

describe('stress fixture specs', () => {
    it('covers every fixture a scenario references', () => {
        for (const scenario of STRESS_SCENARIOS) {
            for (const id of scenario.fixtures) {
                expect(isStressFixtureId(id)).toBe(true);
            }
            for (const id of scenario.workingCopies) {
                expect(scenario.fixtures).toContain(id);
            }
        }
    });

    it('hashes specs independently of parameter order and sensitively to generator version', () => {
        const spec = STRESS_FIXTURE_SPECS['many-pages-text-4000'];
        const reordered = {
            ...spec,
            params: Object.fromEntries(Object.entries(spec.params).reverse()),
        };
        expect(computeStressFixtureSpecHash(reordered)).toBe(computeStressFixtureSpecHash(spec));
        expect(computeStressFixtureSpecHash(spec, 99)).not.toBe(computeStressFixtureSpecHash(spec));
        expect(computeStressFixtureSpecHash({
            ...spec,
            params: {
                ...spec.params,
                pages: 1,
            },
        })).not.toBe(computeStressFixtureSpecHash(spec));
    });

    it('describes each fixture with its id and file name', () => {
        const text = describeStressFixtures();
        for (const id of STRESS_FIXTURE_IDS) {
            expect(text).toContain(`${id} (${STRESS_FIXTURE_SPECS[id].kind}`);
        }
    });
});

describe('stress fixture manifest', () => {
    it('returns an empty manifest for garbage or a foreign schema', () => {
        expect(parseStressFixtureManifest('null').fixtures).toEqual({});
        expect(parseStressFixtureManifest('{"schemaVersion":2,"fixtures":{}}').fixtures).toEqual({});
    });

    it('keeps only well-formed records with known ids', () => {
        const good: IStressFixtureRecord = {
            id: 'text-small-12',
            path: '/tmp/x.pdf',
            bytes: 10,
            specHash: 'abc',
            generatedAt: '2026-09-04T00:00:00.000Z',
            available: true,
            reason: null,
        };
        const manifest = parseStressFixtureManifest(JSON.stringify({
            schemaVersion: 1,
            generatorVersion: 1,
            fixtures: {
                'text-small-12': good,
                'unknown-fixture': good,
                'scanned-large-431': {id: 'scanned-large-431'},
            },
        }));
        expect(Object.keys(manifest.fixtures)).toEqual(['text-small-12']);
        expect(manifest.generatorVersion).toBe(1);
    });
});

describe('stress fixture reuse', () => {
    let dir = '';

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stress-fixture-test-'));
    });

    afterAll(async () => {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    });

    it('reuses a record only when the hash matches and the file has the recorded size', async () => {
        const path = join(dir, 'fixture.pdf');
        await writeFile(path, 'hello');
        const record: IStressFixtureRecord = {
            id: 'text-small-12',
            path,
            bytes: 5,
            specHash: 'hash-1',
            generatedAt: '2026-09-04T00:00:00.000Z',
            available: true,
            reason: null,
        };
        await expect(isStressFixtureRecordReusable(record, 'hash-1')).resolves.toBe(true);
        await expect(isStressFixtureRecordReusable(record, 'hash-2')).resolves.toBe(false);
        await expect(isStressFixtureRecordReusable({
            ...record,
            bytes: 6,
        }, 'hash-1')).resolves.toBe(false);
        await expect(isStressFixtureRecordReusable({
            ...record,
            path: join(dir, 'missing.pdf'),
        }, 'hash-1')).resolves.toBe(false);
        await expect(isStressFixtureRecordReusable(undefined, 'hash-1')).resolves.toBe(false);
    });
});
