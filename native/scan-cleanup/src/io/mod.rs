use evb_raster_io::DecodeLimits;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

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

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_with(path, |file| {
        file.write_all(bytes).map_err(|error| error.to_string())
    })
}

pub(crate) fn write_atomic_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    let temporary = path.with_file_name(PathBuf::from(name));
    let result = (|| {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        write(&mut file)?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
