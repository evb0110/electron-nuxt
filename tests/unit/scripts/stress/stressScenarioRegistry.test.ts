import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_STRESS_BUDGETS,
    DEFAULT_STRESS_RUN_BUDGET,
    DEFAULT_STRESS_THRESHOLDS,
    STRESS_SCENARIOS,
    findStressScenario,
    listStressScenarioIds,
    resolveStressThresholds,
    selectStressScenarios,
} from '@scripts/stress/stressScenarioRegistry';

describe('stress scenario registry', () => {
    it('uses unique kebab-case ids and at least one tag each', () => {
        const ids = listStressScenarioIds();
        expect(new Set(ids).size).toBe(ids.length);
        for (const scenario of STRESS_SCENARIOS) {
            expect(scenario.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
            expect(scenario.tags.length).toBeGreaterThan(0);
            expect(scenario.fixtures.length).toBeGreaterThan(0);
        }
    });

    it('ships both deterministic and operator scenarios', () => {
        expect(STRESS_SCENARIOS.filter(scenario => scenario.kind === 'deterministic').length).toBeGreaterThanOrEqual(5);
        expect(STRESS_SCENARIOS.filter(scenario => scenario.kind === 'operator').length).toBeGreaterThanOrEqual(3);
    });

    it('gives every operator scenario a complete task card and the research guard budgets', () => {
        for (const scenario of STRESS_SCENARIOS) {
            if (scenario.kind !== 'operator') {
                continue;
            }
            expect(scenario.taskCard.steps.length).toBeGreaterThan(0);
            expect(scenario.taskCard.doNot.length).toBeGreaterThan(0);
            expect(scenario.taskCard.goal.length).toBeGreaterThan(0);
            expect(scenario.budgets.maxTurns).toBeLessThanOrEqual(DEFAULT_STRESS_BUDGETS.maxTurns);
            expect(scenario.budgets.maxCostUsd).toBeLessThanOrEqual(DEFAULT_STRESS_BUDGETS.maxCostUsd);
        }
        expect(DEFAULT_STRESS_BUDGETS).toEqual({
            maxTurns: 40,
            maxCostUsd: 2.5,
            deadlineMs: 12 * 60_000,
        });
        expect(DEFAULT_STRESS_RUN_BUDGET.maxCostUsd).toBe(40);
    });

    it('only opens fixtures that the scenario declared', () => {
        for (const scenario of STRESS_SCENARIOS) {
            if (scenario.kind !== 'deterministic') {
                continue;
            }
            expect(scenario.steps.length).toBeGreaterThan(0);
            for (const step of scenario.steps) {
                if (step.kind === 'open') {
                    expect(scenario.fixtures).toContain(step.fixture);
                }
            }
        }
    });

    it('selects by id, tag and kind', () => {
        const first = STRESS_SCENARIOS[0];
        expect(first).toBeDefined();
        if (!first) {
            return;
        }
        expect(selectStressScenarios({ids: [first.id]}).map(scenario => scenario.id)).toEqual([first.id]);
        expect(selectStressScenarios({kind: 'operator'}).every(scenario => scenario.kind === 'operator')).toBe(true);
        const tag = first.tags[0] ?? '';
        expect(selectStressScenarios({tags: [tag]}).every(scenario => scenario.tags.includes(tag))).toBe(true);
        expect(selectStressScenarios({})).toHaveLength(STRESS_SCENARIOS.length);
        expect(() => selectStressScenarios({ids: ['nope']})).toThrow(/Unknown stress scenario/u);
        expect(findStressScenario('nope')).toBeNull();
    });

    it('layers scenario thresholds over the defaults', () => {
        const withOverride = STRESS_SCENARIOS.find(scenario => Object.keys(scenario.thresholds).length > 0);
        expect(withOverride).toBeDefined();
        if (!withOverride) {
            return;
        }
        const resolved = resolveStressThresholds(withOverride);
        for (const [
            key,
            value,
        ] of Object.entries(withOverride.thresholds)) {
            expect(resolved[key as keyof typeof resolved]).toBe(value);
        }
        expect(resolveStressThresholds({
            ...withOverride,
            thresholds: {},
        })).toEqual(DEFAULT_STRESS_THRESHOLDS);
    });
});
