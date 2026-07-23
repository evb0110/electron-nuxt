use serde::Serialize;
use std::{any::Any, error::Error};
use thiserror::Error;

pub mod output;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Error)]
#[serde(rename_all = "kebab-case")]
pub enum NativeErrorCode {
    #[error("encrypted")]
    Encrypted,
    #[error("too-large")]
    TooLarge,
    #[error("corrupt-xref")]
    CorruptXref,
    #[error("unsupported-filter")]
    UnsupportedFilter,
    #[error("invalid-request")]
    InvalidRequest,
    #[error("io")]
    Io,
    #[error("panic")]
    Panic,
    #[error("native-failure")]
    NativeFailure,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
}

impl NativeError {
    pub fn new(code: NativeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeErrorEnvelope {
    pub code: NativeErrorCode,
    pub message: String,
}

impl NativeErrorEnvelope {
    pub fn from_error(error: &(dyn Error + 'static)) -> Self {
        let code = if let Some(native_error) = error.downcast_ref::<NativeError>() {
            native_error.code
        } else if error.downcast_ref::<std::io::Error>().is_some() {
            NativeErrorCode::Io
        } else {
            NativeErrorCode::NativeFailure
        };
        Self {
            code,
            message: error.to_string(),
        }
    }

    pub fn from_panic(payload: Box<dyn Any + Send>) -> Self {
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| (*message).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Native tool panicked".to_string());
        Self {
            code: NativeErrorCode::Panic,
            message,
        }
    }

    pub fn write_stderr(&self) {
        eprintln!("{}", self.to_json());
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"code":"native-failure","message":"Failed to serialize native error"}"#.to_string()
        })
    }
}

pub fn run_cli_caught<F>(operation: F)
where
    F: FnOnce() -> Result<(), Box<dyn Error>> + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(operation) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            NativeErrorEnvelope::from_error(error.as_ref()).write_stderr();
            std::process::exit(1);
        }
        Err(payload) => {
            NativeErrorEnvelope::from_panic(payload).write_stderr();
            std::process::exit(70);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_typed_domain_codes_in_serialized_envelopes() {
        for code in [
            NativeErrorCode::Encrypted,
            NativeErrorCode::TooLarge,
            NativeErrorCode::CorruptXref,
            NativeErrorCode::UnsupportedFilter,
            NativeErrorCode::InvalidRequest,
        ] {
            let error = NativeError::new(code, "localized detail");
            let envelope = NativeErrorEnvelope::from_error(&error);
            assert_eq!(envelope.code, code);
            assert!(envelope.to_json().contains("localized detail"));
        }
    }
}
