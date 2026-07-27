use super::{decode_limits, write_atomic};
use evb_raster_io::{decode_png, encode_png_fast, PixelBuffer};
use scan_primitives::GrayImage;
use std::{io::Cursor, path::Path};

pub use evb_raster_io::DecodedRaster;
pub use scan_primitives::RgbImage;

pub fn decode_gray(bytes: &[u8], max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    Ok(decode_image(bytes, max_pixels, max_dimension)?.gray)
}

pub fn decode_image(
    bytes: &[u8],
    max_pixels: u64,
    max_dimension: u32,
) -> Result<DecodedRaster, String> {
    decode_png(Cursor::new(bytes), decode_limits(max_pixels, max_dimension))
        .map_err(|error| error.to_string())
}

pub fn write_gray_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    write_atomic(path, &encode_gray(image)?)
}

pub fn write_rgb_atomic(path: &Path, image: &RgbImage) -> Result<(), String> {
    write_atomic(path, &encode_rgb(image)?)
}

pub fn encode_gray(image: &GrayImage) -> Result<Vec<u8>, String> {
    encode_png_fast(PixelBuffer::Gray {
        width: image.width(),
        height: image.height(),
        stride: image.stride(),
        data: image.data(),
    })
    .map_err(|error| error.to_string())
}

pub fn encode_rgb(image: &RgbImage) -> Result<Vec<u8>, String> {
    encode_png_fast(PixelBuffer::Rgb {
        width: image.width(),
        height: image.height(),
        stride: image.width().saturating_mul(3),
        data: image.data(),
    })
    .map_err(|error| error.to_string())
}
