import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createSeededRandom,
    planRandomPages,
} from '@scripts/stress/stressDeterministicDriver';

describe('stress deterministic driver randomness', () => {
    it('replays the same sequence for the same seed', () => {
        const first = createSeededRandom(42);
        const second = createSeededRandom(42);
        const values = Array.from({length: 5}, () => first());
        expect(values).toEqual(Array.from({length: 5}, () => second()));
        for (const value of values) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
        expect(createSeededRandom(43)()).not.toBe(createSeededRandom(42)());
    });

    it('plans page jumps inside the document', () => {
        const pages = planRandomPages(4000, 50, 7);
        expect(pages).toHaveLength(50);
        for (const page of pages) {
            expect(page).toBeGreaterThanOrEqual(1);
            expect(page).toBeLessThanOrEqual(4000);
        }
        expect(planRandomPages(4000, 50, 7)).toEqual(pages);
        expect(planRandomPages(0, 3, 1)).toEqual([
            1,
            1,
            1,
        ]);
    });
});
