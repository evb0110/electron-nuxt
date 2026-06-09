use std::{
    fs::{self, File},
    io::BufReader,
    path::Path,
};

use crate::{
    flate::{deflate_up_filtered_rgb_grayscale, deflate_up_filtered_slices},
    jpeg::parse_jpeg_metadata,
    netpbm::{is_rgb_data_grayscale, parse_netpbm},
    pdf::{ImagePage, ImagePayload},
    png::parse_png_reader,
    tiff_io::read_tiff_pdf_pages,
    Result, DEFAULT_DPI,
};

pub(crate) fn read_image_pages(
    path: &Path,
    max_pixels: u64,
    default_dpi: Option<u32>,
    max_tiff_frames: usize,
) -> Result<Vec<ImagePage>> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "tif" || extension == "tiff" {
        return read_tiff_pdf_pages(path, max_pixels, default_dpi, max_tiff_frames);
    }

    let page = match extension.as_str() {
        "png" => read_png_page(path, max_pixels, default_dpi)?,
        "jpg" | "jpeg" => read_jpeg_page(fs::read(path)?, max_pixels, default_dpi)?,
        "pgm" | "ppm" => read_netpbm_page(
            &fs::read(path)?,
            max_pixels,
            default_dpi.unwrap_or(DEFAULT_DPI),
        )?,
        _ => return Err(format!("Unsupported image extension: {}", path.display()).into()),
    };

    Ok(vec![page])
}

fn read_png_page(path: &Path, max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
    let file = File::open(path)?;
    let png = parse_png_reader(BufReader::new(file))?;
    assert_pixel_limit(png.width, png.height, max_pixels)?;

    let (colors, color_space) = match png.color_type {
        0 => (1, "DeviceGray"),
        2 => (3, "DeviceRGB"),
        _ => {
            return Err(format!("Unsupported PNG color type: {}", png.color_type).into());
        }
    };

    let decode_params = format!(
        "<< /Predictor 15 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
        png.width
    );

    Ok(ImagePage {
        width: png.width,
        height: png.height,
        dpi: png.dpi.or(default_dpi).unwrap_or(DEFAULT_DPI),
        color_space,
        payload: ImagePayload::RawFlate {
            data: png.idat,
            decode_params,
        },
    })
}

fn read_jpeg_page(bytes: Vec<u8>, max_pixels: u64, default_dpi: Option<u32>) -> Result<ImagePage> {
    let metadata = parse_jpeg_metadata(&bytes)?;
    assert_pixel_limit(metadata.width, metadata.height, max_pixels)?;
    let color_space = match metadata.components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        _ => {
            return Err(
                format!("Unsupported JPEG component count: {}", metadata.components).into(),
            );
        }
    };

    Ok(ImagePage {
        width: metadata.width,
        height: metadata.height,
        dpi: metadata.dpi.or(default_dpi).unwrap_or(DEFAULT_DPI),
        color_space,
        payload: ImagePayload::Jpeg { data: bytes },
    })
}

fn read_netpbm_page(bytes: &[u8], max_pixels: u64, dpi: u32) -> Result<ImagePage> {
    let netpbm = parse_netpbm(bytes)?;
    assert_pixel_limit(netpbm.width, netpbm.height, max_pixels)?;

    let total_pixels = netpbm.width as usize * netpbm.height as usize;
    let height = netpbm.height as usize;
    let (colors, color_space, compressed): (u32, &'static str, Vec<u8>) = if netpbm.channels == 1 {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_slices(netpbm.pixels, netpbm.width as usize, height)?,
        )
    } else if is_rgb_data_grayscale(netpbm.pixels, total_pixels) {
        (
            1,
            "DeviceGray",
            deflate_up_filtered_rgb_grayscale(netpbm.pixels, netpbm.width as usize, height)?,
        )
    } else {
        (
            3,
            "DeviceRGB",
            deflate_up_filtered_slices(netpbm.pixels, netpbm.width as usize * 3, height)?,
        )
    };

    let decode_params = format!(
        "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
        netpbm.width
    );

    Ok(ImagePage {
        width: netpbm.width,
        height: netpbm.height,
        dpi,
        color_space,
        payload: ImagePayload::RawFlate {
            data: compressed,
            decode_params,
        },
    })
}

pub(crate) fn assert_pixel_limit(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    let pixels = width as u64 * height as u64;
    if width == 0 || height == 0 || pixels > max_pixels {
        return Err(
            format!("Image dimensions are too large to combine safely: {width}x{height}").into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_grayscale_netpbm_pdf_image_payload() {
        let data = b"P6\n2 1\n255\n\x07\x07\x07\x09\x09\x09";
        let page = read_netpbm_page(data, 1_000_000, 300).unwrap();

        assert_eq!(page.width, 2);
        assert_eq!(page.height, 1);
        assert_eq!(page.dpi, 300);
        assert_eq!(page.color_space, "DeviceGray");
        match page.payload {
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => {
                assert!(!data.is_empty());
                assert!(decode_params.contains("/Colors 1"));
                assert!(decode_params.contains("/Columns 2"));
            }
            ImagePayload::Jpeg { .. } => panic!("expected flate payload"),
        }
    }
}
