import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    type IFixtureDescribeSelector,
    resolvePathFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';

function createDescribeSelectorDouble() {
    const skipSelector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    skipSelector.skip = skipSelector;

    const selector = ((_name: string, _fn: () => void) => undefined) as IFixtureDescribeSelector;
    selector.skip = skipSelector;
    return selector;
}

describe('Electron E2E fixture policy', () => {
    it('reports an optional missing fixture once and returns the skipped suite selector', () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-fixture.pdf',
                label: 'missing unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            const firstSelector = selectFixtureDescribe(describeLike, fixture);
            const secondSelector = selectFixtureDescribe(describeLike, fixture);

            expect(firstSelector).toBe(describeLike.skip);
            expect(secondSelector).toBe(describeLike.skip);
            expect(infoSpy).toHaveBeenCalledTimes(1);
            expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('SKIPPED (fixture missing): missing unit-test fixture does not exist:'));
        } finally {
            infoSpy.mockRestore();
        }
    });

    it('fails during suite selection when the selected lane requires a missing fixture', () => {
        const previousValue = process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
        process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = '1';
        const describeLike = createDescribeSelectorDouble();

        try {
            const fixture = resolvePathFixtureAvailability({
                path: '.devkit/definitely-missing-required-fixture.pdf',
                label: 'required unit-test',
                requiredEnvVar: 'EVB_UNIT_REQUIRE_MISSING_FIXTURE',
            });

            expect(() => selectFixtureDescribe(describeLike, fixture)).toThrow(
                /Required fixture missing: required unit-test fixture does not exist:/,
            );
        } finally {
            if (previousValue === undefined) {
                delete process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE;
            } else {
                process.env.EVB_UNIT_REQUIRE_MISSING_FIXTURE = previousValue;
            }
        }
    });
});
