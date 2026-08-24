/**
 * Bounds on the staged Analyze input window shared by the app and the sidecar.
 *
 * A window is a residency bound, not a queue: the owning process promises to
 * keep that many replayable page rasters on disk, and the sidecar never holds
 * leases for more pages than that at once. Both sides enforce the same ceilings,
 * so neither can be talked into a residency or a page pool the other did not
 * agree to.
 */

/** Most Analyze page rasters an owning process may keep staged at once. */
export const SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW = 16;

/**
 * Ceiling on the declared staged-input peak, in pixels. One gigapixel is far
 * above any page a 150-DPI analysis raster reaches and keeps the sidecar's page
 * pool arithmetic inside safe integers.
 */
export const SCAN_CLEANUP_MAX_STAGED_INPUT_PEAK_PIXELS = 1_000_000_000;
