use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{NativeError, NativeErrorCode};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Owns an unpublished sibling file until it is durably replaced into place.
pub struct AtomicOutput {
    file: Option<File>,
    temporary_path: PathBuf,
    destination_path: PathBuf,
    published: bool,
}

impl AtomicOutput {
    pub fn create(destination: &Path) -> io::Result<Self> {
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        let file_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("output");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        for _ in 0..128 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temporary_path = parent.join(format!(
                ".{file_name}.evb-tmp-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
            {
                Ok(file) => {
                    return Ok(Self {
                        file: Some(file),
                        temporary_path,
                        destination_path: destination.to_path_buf(),
                        published: false,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Unable to create a unique sibling output file",
        ))
    }

    pub fn file_mut(&mut self) -> io::Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("Temporary output file is already closed"))
    }

    pub fn publish(mut self) -> io::Result<()> {
        {
            let file = self.file_mut()?;
            file.flush()?;
            file.sync_all()?;
        }
        drop(self.file.take());
        replace_file_atomically(&self.temporary_path, &self.destination_path)?;
        self.published = true;
        sync_parent_directory(&self.destination_path);
        Ok(())
    }
}

impl Drop for AtomicOutput {
    fn drop(&mut self) {
        if !self.published {
            drop(self.file.take());
            let _ = fs::remove_file(&self.temporary_path);
        }
    }
}

/// Retains every validated input descriptor for the duration of an output operation.
pub struct ValidatedInputFiles {
    files: Vec<File>,
}

impl ValidatedInputFiles {
    pub fn open(input_paths: &[PathBuf], output_path: &Path) -> Result<Self, NativeError> {
        let output_file = match File::open(output_path) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(native_io_error(error)),
        };
        if output_file
            .as_ref()
            .is_some_and(|file| file.metadata().is_ok_and(|metadata| !metadata.is_file()))
        {
            return Err(native_failure(format!(
                "Output is not a regular file: {}",
                output_path.display()
            )));
        }
        let output_identity = output_file
            .as_ref()
            .map(file_identity)
            .transpose()
            .map_err(native_io_error)?
            .flatten();
        let output_canonical = output_file
            .as_ref()
            .and_then(|_| fs::canonicalize(output_path).ok());

        let mut files = Vec::new();
        files
            .try_reserve_exact(input_paths.len())
            .map_err(|_| native_failure("Too many input files to validate"))?;

        for input_path in input_paths {
            let file = File::open(input_path).map_err(native_io_error)?;
            let metadata = file.metadata().map_err(native_io_error)?;
            if !metadata.is_file() {
                return Err(native_failure(format!(
                    "Input is not a regular file: {}",
                    input_path.display()
                )));
            }
            let input_identity = file_identity(&file).map_err(native_io_error)?;
            let aliases_output = output_identity
                .as_ref()
                .is_some_and(|output| input_identity.as_ref() == Some(output))
                || output_canonical.as_ref().is_some_and(|output| {
                    fs::canonicalize(input_path).ok().as_ref() == Some(output)
                });
            if aliases_output {
                return Err(native_failure(format!(
                    "Output aliases an input file: {}",
                    input_path.display()
                )));
            }
            files.push(file);
        }

        Ok(Self { files })
    }

    pub fn clone_file(&self, index: usize) -> io::Result<File> {
        self.files
            .get(index)
            .ok_or_else(|| {
                io::Error::other(format!(
                    "Missing validated input descriptor at index {index}"
                ))
            })?
            .try_clone()
    }
}

pub fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut output = AtomicOutput::create(path)?;
    output.file_mut()?.write_all(bytes)?;
    output.publish()
}

pub fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), Box<dyn Error>> {
    let mut output = AtomicOutput::create(path)?;
    serde_json::to_writer(output.file_mut()?, value)?;
    output.publish()?;
    Ok(())
}

fn native_io_error(error: io::Error) -> NativeError {
    NativeError::new(NativeErrorCode::Io, error.to_string())
}

fn native_failure(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::NativeFailure, message)
}

#[derive(Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<Option<FileIdentity>> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(Some(FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
    }))
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<Option<FileIdentity>> {
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
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(Some(FileIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    }))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> io::Result<Option<FileIdentity>> {
    // WASI does not currently expose a stable cross-platform file identity.
    // Native desktop targets use the Unix/Windows implementations above.
    Ok(None)
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary_path: &Path, destination_path: &Path) -> io::Result<()> {
    fs::rename(temporary_path, destination_path)
}

#[cfg(windows)]
fn replace_file_atomically(temporary_path: &Path, destination_path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing: Vec<u16> = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replacement: Vec<u16> = destination_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // The temporary handle is closed before replacement so Windows can publish it.
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(destination_path: &Path) {
    if let Some(parent) = destination_path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_parent_directory(_destination_path: &Path) {}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        env, fs,
        io::{BufWriter, Read, Write},
        process,
        sync::{Arc, Barrier},
        thread,
    };

    use serde::Serializer;

    use super::*;

    #[test]
    fn failed_serialization_preserves_existing_output_and_cleans_temporary() {
        struct FailingValue;

        impl Serialize for FailingValue {
            fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                Err(serde::ser::Error::custom("intentional encoding failure"))
            }
        }

        let destination = test_path("serialization-failure");
        fs::write(&destination, b"existing-output").unwrap();

        let error = write_json_atomically(&destination, &FailingValue).unwrap_err();

        assert!(error.to_string().contains("intentional encoding failure"));
        assert_eq!(fs::read(&destination).unwrap(), b"existing-output");
        assert_no_sibling_temporary(&destination);
        fs::remove_file(destination).unwrap();
    }

    #[test]
    fn explicit_drop_removes_unpublished_temporary() {
        let destination = test_path("drop");
        let output = AtomicOutput::create(&destination).unwrap();
        let temporary_path = output.temporary_path.clone();

        drop(output);

        assert!(!temporary_path.exists());
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn writer_flush_failure_preserves_existing_output_and_cleans_temporary() {
        use std::os::{fd::OwnedFd, unix::net::UnixStream};

        let destination = test_path("flush-failure");
        fs::write(&destination, b"existing-output").unwrap();
        let mut output = AtomicOutput::create(&destination).unwrap();
        let temporary_path = output.temporary_path.clone();
        let (stream, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let descriptor: OwnedFd = stream.into();
        output.file = Some(File::from(descriptor));

        let flush_result = {
            let mut writer = BufWriter::new(output.file_mut().unwrap());
            writer.write_all(b"buffered replacement").unwrap();
            writer.flush()
        };
        assert!(flush_result.is_err());
        drop(output);
        assert_eq!(fs::read(&destination).unwrap(), b"existing-output");
        assert!(!temporary_path.exists());
        fs::remove_file(destination).unwrap();
    }

    #[test]
    fn concurrent_sibling_creation_is_unique() {
        let destination = Arc::new(test_path("concurrent"));
        let thread_count = 16;
        let start = Arc::new(Barrier::new(thread_count));
        let handles = (0..thread_count)
            .map(|_| {
                let destination = Arc::clone(&destination);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    AtomicOutput::create(&destination).unwrap()
                })
            })
            .collect::<Vec<_>>();
        let outputs = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        let paths = outputs
            .iter()
            .map(|output| output.temporary_path.clone())
            .collect::<HashSet<_>>();

        assert_eq!(paths.len(), thread_count);
        drop(outputs);
        assert_no_sibling_temporary(&destination);
    }

    #[test]
    fn rejects_same_file_and_hardlink_output_aliases() {
        let input = test_path("alias-input");
        let hardlink = test_path("alias-output");
        fs::write(&input, b"input").unwrap();

        let same_file_error = ValidatedInputFiles::open(std::slice::from_ref(&input), &input)
            .err()
            .unwrap();
        assert!(same_file_error
            .to_string()
            .contains("Output aliases an input"));

        fs::hard_link(&input, &hardlink).unwrap();
        let hardlink_error = ValidatedInputFiles::open(std::slice::from_ref(&input), &hardlink)
            .err()
            .unwrap();
        assert!(hardlink_error
            .to_string()
            .contains("Output aliases an input"));
        assert_eq!(fs::read(&input).unwrap(), b"input");
        assert_eq!(fs::read(&hardlink).unwrap(), b"input");
        fs::remove_file(input).unwrap();
        fs::remove_file(hardlink).unwrap();
    }

    #[test]
    fn retained_descriptor_survives_input_path_replacement() {
        let input = test_path("retained-input");
        let displaced = test_path("retained-displaced");
        let output = test_path("retained-output");
        fs::write(&input, b"validated-input").unwrap();
        let validated = ValidatedInputFiles::open(std::slice::from_ref(&input), &output).unwrap();

        fs::rename(&input, &displaced).unwrap();
        fs::write(&input, b"replacement-input").unwrap();
        let mut retained = validated.clone_file(0).unwrap();
        let mut bytes = Vec::new();
        retained.read_to_end(&mut bytes).unwrap();

        assert_eq!(bytes, b"validated-input");
        fs::remove_file(input).unwrap();
        fs::remove_file(displaced).unwrap();
    }

    #[test]
    fn atomically_replaces_existing_destination() {
        let destination = test_path("replacement");
        fs::write(&destination, b"old-output").unwrap();

        write_bytes_atomically(&destination, b"new-output").unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new-output");
        assert_no_sibling_temporary(&destination);
        fs::remove_file(destination).unwrap();
    }

    fn test_path(label: &str) -> PathBuf {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        env::temp_dir().join(format!(
            "evb-native-support-{label}-{}-{sequence}",
            process::id()
        ))
    }

    fn assert_no_sibling_temporary(destination: &Path) {
        let parent = destination.parent().unwrap();
        let marker = format!(
            ".{}.evb-tmp-",
            destination.file_name().unwrap().to_string_lossy()
        );
        let leftovers = fs::read_dir(parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "temporary output was not cleaned");
    }
}
