import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolvePdfRenderPerformancePolicy,
    type IPdfRenderPerformancePolicy,
} from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import type { IPerformanceProfile } from '@app/utils/performanceProfile';

interface IPerformancePolicyCase {
    name: string;
    profile: Pick<IPerformanceProfile, 'lowCpu' | 'lowMemory'>;
    expected: IPdfRenderPerformancePolicy;
}

const cases: IPerformancePolicyCase[] = [
    {
        name: 'normal tier',
        profile: {
            lowCpu: false,
            lowMemory: false,
        },
        expected: {
            zoomGestureRasterMode: 'eager',
            outputScaleFloor: 2,
            clampedVisibleRefineMode: 'immediate',
            navigationAnchorRadius: 18,
            layoutPendingRadius: 30,
        },
    },
    {
        name: 'low-CPU constrained tier',
        profile: {
            lowCpu: true,
            lowMemory: false,
        },
        expected: {
            zoomGestureRasterMode: 'idle-once',
            outputScaleFloor: 1,
            clampedVisibleRefineMode: 'input-idle',
            navigationAnchorRadius: 8,
            layoutPendingRadius: 12,
        },
    },
    {
        name: 'low-memory constrained tier',
        profile: {
            lowCpu: false,
            lowMemory: true,
        },
        expected: {
            zoomGestureRasterMode: 'idle-once',
            outputScaleFloor: 1,
            clampedVisibleRefineMode: 'input-idle',
            navigationAnchorRadius: 8,
            layoutPendingRadius: 12,
        },
    },
];

describe('resolvePdfRenderPerformancePolicy', () => {
    it.each(cases)('resolves every field for the $name', ({
        profile,
        expected,
    }) => {
        expect(resolvePdfRenderPerformancePolicy(profile)).toEqual(expected);
    });
});
