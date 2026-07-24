use evb_raster_io::DecodeLimits;

pub mod pbm;
pub mod png;
pub mod raster;

const MAX_COMPRESSED_BYTES: usize = 512 * 1024 * 1024;

pub(crate) fn decode_limits(max_pixels: u64, max_dimension: u32) -> DecodeLimits {
    DecodeLimits {
        max_pixels,
        max_dimension,
        max_compressed_bytes: MAX_COMPRESSED_BYTES,
    }
}
