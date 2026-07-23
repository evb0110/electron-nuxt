import { isRecord } from '@contracts/runtimeGuards';

export type THostResourceTier = 'low' | 'medium' | 'high';
export type TPerformanceMode = 'auto' | THostResourceTier;

export interface IHostGpuStatusSnapshot {[featureName: string]: string;}

export interface IHostResourceProfileSnapshot {
    logicalCpus: number;
    totalRamBytes: number;
    safeMode: boolean;
    gpuStatus?: IHostGpuStatusSnapshot;
    detectedTier: THostResourceTier;
    performanceMode: TPerformanceMode;
    tier: THostResourceTier;
}

export interface IHostResourceTierInputs {
    logicalCpus: number;
    totalRamBytes: number;
}

export const HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX =
    '--evb-host-resource-profile=';

const GIB = 1024 ** 3;

function isHostResourceTier(value: unknown): value is THostResourceTier {
    return value === 'low' || value === 'medium' || value === 'high';
}

function isPerformanceMode(value: unknown): value is TPerformanceMode {
    return value === 'auto' || isHostResourceTier(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function decodeHostGpuStatusSnapshot(value: unknown): IHostGpuStatusSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }

    const snapshot: IHostGpuStatusSnapshot = {};
    for (const [
        featureName,
        status,
    ] of Object.entries(value)) {
        if (typeof status !== 'string') {
            return null;
        }
        snapshot[featureName] = status;
    }
    return snapshot;
}

export function resolveDetectedHostResourceTier(
    inputs: IHostResourceTierInputs,
): THostResourceTier {
    const {
        logicalCpus,
        totalRamBytes,
    } = inputs;
    if (logicalCpus <= 0 || totalRamBytes <= 0) {
        return 'medium';
    }

    const ramGiB = totalRamBytes / GIB;
    if (
        ramGiB <= 8
        || logicalCpus <= 2
        || (ramGiB <= 12 && logicalCpus <= 4)
    ) {
        return 'low';
    }
    if (ramGiB >= 16 && logicalCpus >= 8) {
        return 'high';
    }
    return 'medium';
}

export function resolveEffectiveHostResourceTier(
    detectedTier: THostResourceTier,
    performanceMode: TPerformanceMode,
): THostResourceTier {
    return performanceMode === 'auto' ? detectedTier : performanceMode;
}

export function decodeHostResourceProfileSnapshot(
    value: unknown,
): IHostResourceProfileSnapshot | null {
    if (
        !isRecord(value)
        || !isNonNegativeSafeInteger(value.logicalCpus)
        || !isNonNegativeSafeInteger(value.totalRamBytes)
        || typeof value.safeMode !== 'boolean'
        || !isHostResourceTier(value.detectedTier)
        || !isPerformanceMode(value.performanceMode)
        || !isHostResourceTier(value.tier)
    ) {
        return null;
    }

    const detectedTier = resolveDetectedHostResourceTier({
        logicalCpus: value.logicalCpus,
        totalRamBytes: value.totalRamBytes,
    });
    if (
        value.detectedTier !== detectedTier
        || value.tier !== resolveEffectiveHostResourceTier(
            value.detectedTier,
            value.performanceMode,
        )
    ) {
        return null;
    }

    const gpuStatus = value.gpuStatus === undefined
        ? undefined
        : decodeHostGpuStatusSnapshot(value.gpuStatus);
    if (gpuStatus === null) {
        return null;
    }

    return {
        logicalCpus: value.logicalCpus,
        totalRamBytes: value.totalRamBytes,
        safeMode: value.safeMode,
        ...(gpuStatus === undefined ? {} : {gpuStatus}),
        detectedTier: value.detectedTier,
        performanceMode: value.performanceMode,
        tier: value.tier,
    };
}
