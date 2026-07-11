import type { ISystemMemoryInfo } from '@contracts/electronApiSystem';
import type {
    IWorkspaceSurfaceBudgetSnapshot,
    TWorkspaceResourcePressureLevel,
} from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';

export interface IWorkspaceMemoryPressureSample {
    memoryInfo: ISystemMemoryInfo | null;
    surfaces: Pick<IWorkspaceSurfaceBudgetSnapshot, 'maxBytes' | 'reservedBytes'>;
    systemFreeReserveBytes: number;
    postCrashSafeMode?: boolean | undefined;
}

export function resolveWorkspaceResourcePressureLevel(
    sample: IWorkspaceMemoryPressureSample,
): TWorkspaceResourcePressureLevel {
    if (sample.postCrashSafeMode) {
        return 'post-crash-safe-mode';
    }
    const reservationRatio = sample.surfaces.maxBytes > 0
        ? sample.surfaces.reservedBytes / sample.surfaces.maxBytes
        : 0;
    const freeRatio = sample.memoryInfo && sample.systemFreeReserveBytes > 0
        ? sample.memoryInfo.freeBytes / sample.systemFreeReserveBytes
        : Number.POSITIVE_INFINITY;

    if (freeRatio <= 0.25 || reservationRatio >= 1.2) {
        return 'emergency';
    }
    if (freeRatio <= 0.5 || reservationRatio >= 1) {
        return 'critical';
    }
    if (freeRatio <= 0.75 || reservationRatio >= 0.9) {
        return 'moderate';
    }
    if (freeRatio < 1 || reservationRatio >= 0.75) {
        return 'guarded';
    }
    return 'healthy';
}
