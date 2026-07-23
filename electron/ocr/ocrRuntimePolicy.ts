import { clamp } from 'es-toolkit/math';
import type { IHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';

const MIB = 1024 * 1024;
const LOW_MEMORY_BYTES = 8 * 1024 * MIB;
const BASE_NORMAL_PAGE_SLOTS = 3;
const MAX_NORMAL_PAGE_SLOTS = 8;
const LOW_MEMORY_PAGE_SLOTS = 2;
const NORMAL_RENDERED_PAGE_BYTES = 33_660_000;

export interface IOcrRuntimePolicy {globalPageSlots: number;}

function parsePositiveInt(value: string | undefined) {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getCpuSlotCount(logicalCpus: number) {
    return clamp(Math.floor(logicalCpus / 2), 1, MAX_NORMAL_PAGE_SLOTS);
}

function getMemorySlotCount(memoryBytes: number) {
    if (memoryBytes <= 0) {
        return BASE_NORMAL_PAGE_SLOTS;
    }

    const memoryBudgetRatio = memoryBytes >= 32 * 1024 * MIB
        ? 0.18
        : memoryBytes >= 16 * 1024 * MIB
            ? 0.12
            : 0.08;
    return clamp(
        Math.floor((memoryBytes * memoryBudgetRatio) / NORMAL_RENDERED_PAGE_BYTES),
        1,
        MAX_NORMAL_PAGE_SLOTS,
    );
}

export function resolveOcrResourcePolicy(
    profile: IHostResourceProfileSnapshot,
    env: NodeJS.ProcessEnv,
): IOcrRuntimePolicy {
    const configuredPageSlots = parsePositiveInt(env.OCR_GLOBAL_PAGE_SLOTS);
    const globalPageSlots = configuredPageSlots === null
        ? profile.tier === 'low'
            ? 1
            : profile.totalRamBytes > 0 && profile.totalRamBytes < LOW_MEMORY_BYTES
                ? LOW_MEMORY_PAGE_SLOTS
                : clamp(
                    Math.min(
                        getCpuSlotCount(profile.logicalCpus),
                        getMemorySlotCount(profile.totalRamBytes),
                    ),
                    1,
                    MAX_NORMAL_PAGE_SLOTS,
                )
        : clamp(configuredPageSlots, 1, MAX_NORMAL_PAGE_SLOTS);

    return {globalPageSlots};
}

export function getOcrRuntimePolicy() {
    return resolveOcrResourcePolicy(
        getHostResourceProfileSnapshot(),
        process.env,
    );
}
