use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::Result;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Keeps every validated input open for the duration of an output operation.
/// Callers decode clones of these exact descriptors so path replacement after
/// validation cannot change either the selected input or its alias identity.
pub(crate) struct ValidatedInputs {
    files: Vec<File>,
}

impl ValidatedInputs {
    pub(crate) fn file(&self, index: usize) -> Result<File> {
        self.files
            .get(index)
            .ok_or_else(|| format!("Missing validated input descriptor at index {index}"))?
            .try_clone()
            .map_err(Into::into)
    }
}

pub(crate) fn validate_output_inputs(
    input_paths: &[PathBuf],
    output_path: &Path,
) -> Result<ValidatedInputs> {
    let output_file = match File::open(output_path) {
        Ok(file) => Some(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if output_file
        .as_ref()
        .is_some_and(|file| file.metadata().is_ok_and(|metadata| !metadata.is_file()))
    {
        return Err(format!("Output is not a regular file: {}", output_path.display()).into());
    }
    let output_identity = output_file
        .as_ref()
        .map(file_identity)
        .transpose()?
        .flatten();
    let output_canonical = output_file
        .as_ref()
        .and_then(|_| fs::canonicalize(output_path).ok());

    let mut files = Vec::new();
    files
        .try_reserve_exact(input_paths.len())
        .map_err(|_| "Too many input files to validate")?;

    for input_path in input_paths {
        let file = File::open(input_path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(format!("Input is not a regular file: {}", input_path.display()).into());
        }
        let input_identity = file_identity(&file)?;
        let aliases_output = output_identity
            .as_ref()
            .is_some_and(|output| input_identity.as_ref() == Some(output))
            || output_canonical
                .as_ref()
                .is_some_and(|output| fs::canonicalize(input_path).ok().as_ref() == Some(output));
        if aliases_output {
            return Err(format!("Output aliases an input file: {}", input_path.display()).into());
        }
        files.push(file);
    }

    Ok(ValidatedInputs { files })
}

pub(crate) fn write_atomically(
    output_path: &Path,
    write_output: impl FnOnce(&mut File) -> Result<()>,
) -> Result<()> {
    let mut pending = PendingOutput::create(output_path)?;
    write_output(pending.file_mut()?)?;
    pending.file_mut()?.flush()?;
    pending.file_mut()?.sync_all()?;
    pending.publish()
}

struct PendingOutput {
    file: Option<File>,
    temp_path: PathBuf,
    output_path: PathBuf,
    published: bool,
}

impl PendingOutput {
    fn create(output_path: &Path) -> Result<Self> {
        let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
        let file_name = output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("output");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        for _ in 0..128 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temp_path = parent.join(format!(
                ".{file_name}.evb-tmp-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)
            {
                Ok(file) => {
                    return Ok(Self {
                        file: Some(file),
                        temp_path,
                        output_path: output_path.to_path_buf(),
                        published: false,
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }

        Err("Unable to create a unique sibling output file".into())
    }

    fn file_mut(&mut self) -> Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| "Temporary output file is already closed".into())
    }

    fn publish(mut self) -> Result<()> {
        drop(self.file.take());
        replace_file_atomically(&self.temp_path, &self.output_path)?;
        self.published = true;
        sync_parent_directory(&self.output_path);
        Ok(())
    }
}

impl Drop for PendingOutput {
    fn drop(&mut self) {
        if !self.published {
            drop(self.file.take());
            let _ = fs::remove_file(&self.temp_path);
        }
    }
}

#[derive(Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<Option<FileIdentity>> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(Some(FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
    }))
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<Option<FileIdentity>> {
    use std::{ffi::c_void, mem::MaybeUninit, os::windows::io::AsRawHandle};

    #[repr(C)]
    struct FileTime {
        _low: u32,
        _high: u32,
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        _attributes: u32,
        _creation_time: FileTime,
        _last_access_time: FileTime,
        _last_write_time: FileTime,
        volume_serial_number: u32,
        _file_size_high: u32,
        _file_size_low: u32,
        _number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            file: *mut c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    let result = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let information = unsafe { information.assume_init() };
    Ok(Some(FileIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    }))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> Result<Option<FileIdentity>> {
    // WASI does not currently expose a stable cross-platform file identity.
    // Native desktop targets use the Unix/Windows implementations above.
    Ok(None)
}

#[cfg(not(windows))]
fn replace_file_atomically(temp_path: &Path, output_path: &Path) -> Result<()> {
    fs::rename(temp_path, output_path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file_atomically(temp_path: &Path, output_path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement: Vec<u16> = output_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // The temporary handle is closed before this call. MOVEFILE_REPLACE_EXISTING
    // gives Windows the same single-step publication semantics as Unix rename;
    // WRITE_THROUGH requests that the move reach durable storage before return.
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(output_path: &Path) {
    if let Some(parent) = output_path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_parent_directory(_output_path: &Path) {}
