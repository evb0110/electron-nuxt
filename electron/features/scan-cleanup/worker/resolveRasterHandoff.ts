import { statfs } from 'fs/promises';
import type { TWorkerLog } from '@electron/ocr/worker/types';

// PPM removes the costly PNG encode/decode step on both sides of the native
// handoff: pdftoppm writes a JPEG 2000 scan page in about a second where the
// same page spends five more seconds in deflate. The cost is scratch space, so
// the fast handoff stays available for as long as the scratch volume can hold
// the whole manifest without crowding the run's own outputs.
//
// The whole manifest is the unit because it is what is actually resident: both
// batch paths rasterize every page before their sidecar starts and delete
// nothing until the run ends. Narrow this estimate to the rasterizer's window
// only together with a design that streams pages into the sidecar; against
// today's sequencing a per-window estimate would choose PPM for a document the
// scratch volume cannot hold.
const RAW_RASTER_BUDGET_FLOOR_BYTES = 512 * 1024 * 1024;
const RAW_RASTER_FREE_SPACE_SHARE = 0.25;
const PPM_HEADER_ESTIMATE_BYTES = 64;

export interface IScanCleanupRasterHandoffPlan {
    renderDpi: number;
    raster: {
        dpi: number;
        width: number;
        height: number
    } | undefined;
}

export async function readAvailableScratchBytes(directory: string) {
    try {
        const filesystem = await statfs(directory);
        const available = Number(filesystem.bavail) * Number(filesystem.bsize);
        return Number.isFinite(available) && available > 0 ? available : null;
    } catch {
        return null;
    }
}

function estimateRawRasterBytes(plans: readonly IScanCleanupRasterHandoffPlan[]) {
    let estimatedBytes = 0;
    for (const plan of plans) {
        const raster = plan.raster;
        if (
            raster === undefined
            || !Number.isFinite(plan.renderDpi)
            || plan.renderDpi <= 0
            || !Number.isFinite(raster.dpi)
            || raster.dpi <= 0
            || !Number.isFinite(raster.width)
            || raster.width <= 0
            || !Number.isFinite(raster.height)
            || raster.height <= 0
        ) {
            return null;
        }
        const width = Math.max(1, Math.ceil(raster.width * plan.renderDpi / raster.dpi));
        const height = Math.max(1, Math.ceil(raster.height * plan.renderDpi / raster.dpi));
        estimatedBytes += width * height * 3 + PPM_HEADER_ESTIMATE_BYTES;
        if (!Number.isSafeInteger(estimatedBytes)) {
            return null;
        }
    }
    return estimatedBytes;
}

export async function resolveRasterHandoff(
    plans: readonly IScanCleanupRasterHandoffPlan[],
    scratch: string,
    getAvailableScratchBytes: typeof readAvailableScratchBytes,
) {
    const estimatedBytes = estimateRawRasterBytes(plans);
    if (estimatedBytes === null) {
        return {
            format: 'png' as const,
            estimatedBytes: null,
            budgetBytes: null,
        };
    }
    const availableBytes = await getAvailableScratchBytes(scratch);
    const budgetBytes = Math.max(
        RAW_RASTER_BUDGET_FLOOR_BYTES,
        availableBytes === null ? 0 : Math.floor(availableBytes * RAW_RASTER_FREE_SPACE_SHARE),
    );
    return {
        format: estimatedBytes > budgetBytes ? 'png' as const : 'ppm' as const,
        estimatedBytes,
        budgetBytes,
    };
}

export function logRasterHandoff(
    log: TWorkerLog,
    scope: string,
    handoff: Awaited<ReturnType<typeof resolveRasterHandoff>>,
) {
    const mib = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MiB`;
    const footprint = handoff.estimatedBytes === null
        ? 'unknown footprint'
        : `${mib(handoff.estimatedBytes)} estimated footprint`;
    const budget = handoff.budgetBytes === null ? '' : ` against a ${mib(handoff.budgetBytes)} scratch budget`;
    log('debug', `Scan cleanup ${scope} raster handoff uses ${handoff.format.toUpperCase()} (${footprint}${budget})`);
}
