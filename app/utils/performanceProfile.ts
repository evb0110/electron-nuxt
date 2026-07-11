import { getSystemCapability } from '@app/utils/getSystemCapability';

export const PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT = 2 ** 25;
export const PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY = 2 ** 26;
export const PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION = 2 ** 27;
export const PDF_BUFFER_PAGES_DEFAULT = 2;
export const PDF_BUFFER_PAGES_WORKSTATION = 4;
export const PDF_BUFFER_PAGES_LOW_MEMORY = 1;
export const PDF_RENDER_CONCURRENCY_DEFAULT = 3;
export const PDF_RENDER_CONCURRENCY_LOW_MEMORY = 2;
export const PDF_RENDER_CONCURRENCY_LOW_CPU = 1;
export const PDF_RENDER_CONCURRENCY_WORKSTATION_MAX = 6;
export const PDF_PAGE_PROXY_CACHE_DEFAULT = 48;
export const PDF_PAGE_PROXY_CACHE_WORKSTATION = 96;
export const PDF_PAGE_PROXY_CACHE_LOW_MEMORY = 16;
export const PDF_THUMBNAIL_CONCURRENCY_DEFAULT = 2;
export const PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE = 1;
export const PDF_THUMBNAIL_CONCURRENCY_WORKSTATION = 4;
export const PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT = 16_777_216;
export const PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY = 8_388_608;
export const PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION = 33_554_432;

interface IPerformanceProfileNavigator extends Navigator {deviceMemory?: number;}

export interface IPerformanceProfileEnvironment {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    totalMemoryBytes?: number;
}

export interface IPerformanceProfile {
    lowMemory: boolean;
    lowCpu: boolean;
    pdfBufferPages: number;
    concurrentPdfRenders: number;
    maxCachedPdfPages: number;
    thumbnailBaseConcurrency: number;
    settledMaxCanvasPixels: number;
    maxBufferCanvasPixels: number;
}

let cachedPerformanceProfile: IPerformanceProfile | null = null;

function readNavigatorPerformanceEnvironment(): IPerformanceProfileEnvironment {
    if (typeof navigator === 'undefined') {
        return {};
    }

    const runtimeNavigator = navigator as IPerformanceProfileNavigator;
    const environment: IPerformanceProfileEnvironment = {};
    if (typeof runtimeNavigator.deviceMemory === 'number') {
        environment.deviceMemory = runtimeNavigator.deviceMemory;
    }
    if (typeof runtimeNavigator.hardwareConcurrency === 'number') {
        environment.hardwareConcurrency = runtimeNavigator.hardwareConcurrency;
    }
    const memoryInfo = getSystemCapability().getMemoryInfo?.();
    if (typeof memoryInfo?.totalBytes === 'number') {
        environment.totalMemoryBytes = memoryInfo.totalBytes;
    }

    return environment;
}

function normalizePositiveNumber(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

export function resolvePerformanceProfile(
    environment: IPerformanceProfileEnvironment = readNavigatorPerformanceEnvironment(),
): IPerformanceProfile {
    const deviceMemory = normalizePositiveNumber(environment.deviceMemory);
    const hardwareConcurrency = normalizePositiveNumber(environment.hardwareConcurrency);
    const totalMemoryBytes = normalizePositiveNumber(environment.totalMemoryBytes);
    const totalMemoryGiB = totalMemoryBytes === null
        ? null
        : totalMemoryBytes / (1024 ** 3);
    const lowMemory = totalMemoryGiB !== null
        ? totalMemoryGiB <= 8
        : (deviceMemory ?? 4) <= 4;
    const highCanvasMemory = totalMemoryGiB !== null
        ? totalMemoryGiB >= 16
        : (deviceMemory ?? 0) >= 8;
    const workstationMemory = totalMemoryGiB !== null && totalMemoryGiB >= 32;
    const lowCpu = (hardwareConcurrency ?? 4) <= 4;
    const workstationCpu = hardwareConcurrency !== null && hardwareConcurrency >= 12;
    const workstationProfile = workstationMemory && workstationCpu;
    const concurrentPdfRenders = workstationProfile
        ? Math.min(
            PDF_RENDER_CONCURRENCY_WORKSTATION_MAX,
            Math.max(PDF_RENDER_CONCURRENCY_DEFAULT + 1, Math.floor(hardwareConcurrency / 4)),
        )
        : lowCpu
            ? PDF_RENDER_CONCURRENCY_LOW_CPU
            : lowMemory
                ? PDF_RENDER_CONCURRENCY_LOW_MEMORY
                : PDF_RENDER_CONCURRENCY_DEFAULT;

    return {
        lowMemory,
        lowCpu,
        pdfBufferPages: workstationProfile
            ? PDF_BUFFER_PAGES_WORKSTATION
            : lowMemory
                ? PDF_BUFFER_PAGES_LOW_MEMORY
                : PDF_BUFFER_PAGES_DEFAULT,
        concurrentPdfRenders,
        maxCachedPdfPages: workstationProfile
            ? PDF_PAGE_PROXY_CACHE_WORKSTATION
            : lowMemory
                ? PDF_PAGE_PROXY_CACHE_LOW_MEMORY
                : PDF_PAGE_PROXY_CACHE_DEFAULT,
        thumbnailBaseConcurrency: workstationProfile
            ? PDF_THUMBNAIL_CONCURRENCY_WORKSTATION
            : lowMemory || lowCpu
                ? PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE
                : PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
        settledMaxCanvasPixels: workstationMemory
            ? PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION
            : highCanvasMemory
                ? PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY
                : PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
        maxBufferCanvasPixels: workstationProfile
            ? PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION
            : lowMemory
                ? PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY
                : PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
    };
}

export function getPerformanceProfile() {
    cachedPerformanceProfile ??= resolvePerformanceProfile();
    return cachedPerformanceProfile;
}
