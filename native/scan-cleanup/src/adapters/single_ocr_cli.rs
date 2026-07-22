//! Direct single-image adapter retained for OCR preprocessing.

use crate::domain::options::CleanupOptions;
use evb_native_support::{NativeError, NativeErrorCode};
use std::{fs, path::PathBuf};

pub(crate) fn required_path(args: &[String], name: &str) -> Result<PathBuf, NativeError> {
    optional_value(args, name)
        .map(PathBuf::from)
        .ok_or_else(|| invalid(format!("Missing required argument {name}")))
}

pub(crate) fn optional_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|argument| argument == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

pub(crate) fn parse_options(value: &str) -> Result<CleanupOptions, NativeError> {
    let json = if value.trim_start().starts_with('{') {
        value.as_bytes().to_vec()
    } else {
        fs::read(value).map_err(|error| invalid(format!("Unable to read options: {error}")))?
    };
    serde_json::from_slice(&json)
        .map_err(|error| invalid(format!("Invalid cleanup options: {error}")))
}

pub(crate) fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}
