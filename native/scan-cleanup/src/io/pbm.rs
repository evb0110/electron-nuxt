use scan_primitives::GrayImage;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

pub fn write_p4_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    let bytes = evb_raster_io::encode_p4(image).map_err(|error| error.to_string())?;
    let temporary = temporary_sibling(path);
    let result = (|| {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn read_p4(path: &Path, max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    decode_p4(
        &fs::read(path).map_err(|error| error.to_string())?,
        max_pixels,
        max_dimension,
    )
}

pub fn decode_p4(bytes: &[u8], max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    evb_raster_io::decode_p4(bytes, max_pixels, max_dimension).map_err(|error| error.to_string())
}

fn temporary_sibling(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(name)
}
