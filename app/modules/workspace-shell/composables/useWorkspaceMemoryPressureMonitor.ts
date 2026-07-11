import { useIntervalFn } from '@vueuse/core';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import { resolveWorkspaceMemoryBudget } from '@app/modules/workspace-shell/memory/workspaceMemoryBudget';
import { resolveWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/resolveWorkspaceResourcePressureLevel';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';

const MEMORY_SAMPLE_INTERVAL_MS = 2_000;

/** Keeps the renderer raster ledger aligned with live host memory headroom. */
export const useWorkspaceMemoryPressureMonitor = () => {
    const sample = () => {
        const memoryInfo = getSystemCapability().getMemoryInfo();
        const budget = resolveWorkspaceMemoryBudget({environment: memoryInfo ? { totalMemoryBytes: memoryInfo.totalBytes } : undefined});
        workspaceSurfaceBudgetController.setPressureLevel(resolveWorkspaceResourcePressureLevel({
            memoryInfo,
            surfaces: workspaceSurfaceBudgetController.getSnapshot(),
            systemFreeReserveBytes: budget.systemFreeReserveBytes,
        }));
    };

    sample();
    useIntervalFn(sample, MEMORY_SAMPLE_INTERVAL_MS);
};
