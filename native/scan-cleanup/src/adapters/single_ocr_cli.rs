//! Direct single-image adapter retained for OCR preprocessing.

use crate::domain::options::CleanupOptions;
use evb_native_support::{
    bounded_io::{deserialize_json_slice, read_file_bounded},
    NativeError, NativeErrorCode,
};
use std::path::Path;

const MAX_OPTIONS_BYTES: usize = 5 * 1024 * 1024;

pub(crate) fn parse_options(value: &str) -> Result<CleanupOptions, NativeError> {
    parse_options_with_limit(value, MAX_OPTIONS_BYTES)
}

fn parse_options_with_limit(value: &str, max_bytes: usize) -> Result<CleanupOptions, NativeError> {
    let json = if value.trim_start().starts_with('{') {
        if value.len() > max_bytes {
            return Err(NativeError::new(
                NativeErrorCode::TooLarge,
                format!("Cleanup options exceed the {max_bytes}-byte admission ceiling"),
            ));
        }
        value.as_bytes().to_vec()
    } else {
        read_file_bounded(Path::new(value), max_bytes, "cleanup options").map_err(|error| {
            if error.code == NativeErrorCode::TooLarge {
                error
            } else {
                invalid(error.to_string())
            }
        })?
    };
    deserialize_json_slice(&json, "cleanup options").map_err(|error| {
        if error.code == NativeErrorCode::TooLarge {
            error
        } else {
            invalid(error.to_string())
        }
    })
}

pub(crate) fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_options_reject_the_byte_after_the_admission_limit() {
        let error = parse_options_with_limit("{}", 1).unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("1-byte admission ceiling"));
    }
}
