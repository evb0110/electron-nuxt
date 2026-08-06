use evb_raster_io::DecodeLimits;
use std::{
    error::Error,
    fmt,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub mod pbm;
pub mod png;
pub mod raster;

pub(crate) const MAX_COMPRESSED_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_STREAM_INPUT_BYTES: usize = MAX_COMPRESSED_BYTES;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub(crate) enum BoundedIoError {
    Canceled,
    Io(std::io::Error),
    TooLarge { limit: usize },
}

impl fmt::Display for BoundedIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Canceled => formatter.write_str("input copy was canceled"),
            Self::Io(error) => error.fmt(formatter),
            Self::TooLarge { limit } => {
                write!(formatter, "input exceeds guardrails ({limit}-byte limit)")
            }
        }
    }
}

impl Error for BoundedIoError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Canceled | Self::TooLarge { .. } => None,
        }
    }
}

impl From<std::io::Error> for BoundedIoError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub(crate) fn copy_bounded_cancelable(
    source: &mut impl Read,
    destination: &mut impl Write,
    max_bytes: usize,
    is_canceled: impl Fn() -> bool,
) -> Result<u64, BoundedIoError> {
    let mut copied = 0usize;
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        // Probe at most one byte past the allowance, and never publish that
        // byte, so streams cannot grow either memory or scratch without bound.
        let remaining_with_probe = max_bytes.saturating_sub(copied).saturating_add(1);
        let read_limit = remaining_with_probe.min(buffer.len());
        let count = loop {
            match source.read(&mut buffer[..read_limit]) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => break result?,
            }
        };
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        if count == 0 {
            return Ok(copied as u64);
        }
        if count > max_bytes.saturating_sub(copied) {
            return Err(BoundedIoError::TooLarge { limit: max_bytes });
        }
        destination.write_all(&buffer[..count])?;
        copied += count;
    }
}

pub(crate) fn read_file_bounded(path: &Path, max_bytes: usize) -> Result<Vec<u8>, BoundedIoError> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > max_bytes as u64 {
        return Err(BoundedIoError::TooLarge { limit: max_bytes });
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    copy_bounded_cancelable(&mut file, &mut bytes, max_bytes, || false)?;
    Ok(bytes)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Cursor,
        sync::atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn bounded_copy_rejects_an_oversize_stream_without_crossing_the_limit() {
        let mut source = Cursor::new(b"12345");
        let mut destination = Vec::new();

        let error =
            copy_bounded_cancelable(&mut source, &mut destination, 4, || false).unwrap_err();

        assert!(matches!(error, BoundedIoError::TooLarge { limit: 4 }));
        assert!(destination.len() <= 4);
    }

    #[test]
    fn bounded_copy_checks_cancellation_after_each_read() {
        struct CancelingReader<'a> {
            canceled: &'a AtomicBool,
        }
        impl Read for CancelingReader<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer[..4].copy_from_slice(b"data");
                self.canceled.store(true, Ordering::Release);
                Ok(4)
            }
        }
        let canceled = AtomicBool::new(false);
        let mut source = CancelingReader {
            canceled: &canceled,
        };
        let mut destination = Vec::new();

        let error = copy_bounded_cancelable(&mut source, &mut destination, 16, || {
            canceled.load(Ordering::Acquire)
        })
        .unwrap_err();

        assert!(matches!(error, BoundedIoError::Canceled));
        assert!(destination.is_empty());
    }
}
