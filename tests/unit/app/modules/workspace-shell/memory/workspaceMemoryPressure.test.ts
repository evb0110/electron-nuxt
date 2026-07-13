import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/resolveWorkspaceResourcePressureLevel';

describe('workspace memory pressure', () => {
    const sample = (availableBytes: number, reservedBytes = 0) => resolveWorkspaceResourcePressureLevel({
        memoryInfo: {
            availableBytes,
            totalBytes: 8_000,
            freeBytes: availableBytes,
        },
        surfaces: {
            maxBytes: 1_000,
            reservedBytes,
        },
        systemFreeReserveBytes: 1_000,
    });

    it('resolves the degradation ladder from host headroom and reservations', () => {
        expect(sample(2_000)).toBe('healthy');
        expect(sample(900)).toBe('guarded');
        expect(sample(700)).toBe('moderate');
        expect(sample(400)).toBe('critical');
        expect(sample(200)).toBe('emergency');
        expect(sample(2_000, 1_250)).toBe('emergency');
    });

    it('honors crash-safe mode independently of sampled memory', () => {
        expect(resolveWorkspaceResourcePressureLevel({
            memoryInfo: null,
            surfaces: {
                maxBytes: 1_000,
                reservedBytes: 0,
            },
            systemFreeReserveBytes: 1_000,
            postCrashSafeMode: true,
        })).toBe('post-crash-safe-mode');
    });

    it('uses reclaimable host memory instead of raw free pages', () => {
        expect(resolveWorkspaceResourcePressureLevel({
            memoryInfo: {
                availableBytes: 6_000,
                totalBytes: 8_000,
                freeBytes: 100,
            },
            surfaces: {
                maxBytes: 1_000,
                reservedBytes: 0,
            },
            systemFreeReserveBytes: 1_000,
        })).toBe('healthy');
    });
});
