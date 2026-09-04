import {
    describe,
    expect,
    it,
} from 'vitest';
import { AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV } from '@scripts/electron-run/electronRunLaunchConfig';
import {
    STRESS_HOST_PROFILES,
    STRESS_HOST_PROFILE_IDS,
    buildStressProfileSessionEnv,
    describeStressHostProfile,
    isStressHostProfileId,
    resolveStressHostProfile,
} from '@scripts/stress/stressHostProfiles';

describe('stress host profiles', () => {
    it('resolves every declared profile id back to itself', () => {
        for (const id of STRESS_HOST_PROFILE_IDS) {
            expect(isStressHostProfileId(id)).toBe(true);
            expect(resolveStressHostProfile(id).id).toBe(id);
        }
        expect(STRESS_HOST_PROFILE_IDS).toContain('baseline');
        expect(STRESS_HOST_PROFILE_IDS).toContain('slow-a');
    });

    it('rejects unknown ids with the known list in the message', () => {
        expect(isStressHostProfileId('turbo')).toBe(false);
        expect(() => resolveStressHostProfile('turbo')).toThrow(/baseline/u);
    });

    it('keeps the baseline profile unconstrained', () => {
        const baseline = STRESS_HOST_PROFILES.baseline;
        expect(baseline.chromiumSwitches).toEqual([]);
        expect(baseline.cpuThrottlingRate).toBe(1);
        expect(buildStressProfileSessionEnv(baseline)).toEqual({});
    });

    it('routes chromium switches through the launch-config env hook', () => {
        const slow = STRESS_HOST_PROFILES['slow-a'];
        expect(slow.chromiumSwitches.length).toBeGreaterThan(0);
        expect(slow.cpuThrottlingRate).toBeGreaterThan(1);
        const env = buildStressProfileSessionEnv(slow);
        expect(env[AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV]).toBe(slow.chromiumSwitches.join(' '));
    });

    it('describes a profile with its label, switches and throttling rate', () => {
        const text = describeStressHostProfile(STRESS_HOST_PROFILES['slow-a']);
        expect(text).toContain('SLOW-A');
        expect(text).toContain('cpu throttling rate: 4');
        expect(text).toContain(STRESS_HOST_PROFILES['slow-a'].chromiumSwitches[0] ?? '');
    });

    it('declares calibration expectations consistent with the throttling rate', () => {
        for (const profile of Object.values(STRESS_HOST_PROFILES)) {
            if (profile.cpuThrottlingRate > 1) {
                expect(profile.calibration.rendererSlowdownMin).toBeLessThanOrEqual(profile.cpuThrottlingRate);
                expect(profile.calibration.rendererSlowdownMax).toBeGreaterThanOrEqual(profile.cpuThrottlingRate);
            }
            expect(profile.deviceMetrics.width).toBeGreaterThan(0);
            expect(profile.deviceMetrics.height).toBeGreaterThan(0);
        }
    });
});
