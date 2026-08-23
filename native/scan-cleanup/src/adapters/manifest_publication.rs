use crate::{io::StagedFileBackup, protocol::manifest_v3::ManifestV3};
use evb_native_support::{NativeError, NativeErrorCode};
use std::{
    collections::HashSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

struct ManifestPublicationTransaction {
    destinations: Vec<PathBuf>,
    backups: Vec<StagedFileBackup>,
}

impl ManifestPublicationTransaction {
    fn begin(manifest: &ManifestV3) -> Result<Self, String> {
        let destinations = manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        let mut transaction = Self {
            destinations,
            backups: Vec::new(),
        };
        for path in transaction.destinations.clone() {
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() => match StagedFileBackup::stage(&path) {
                    Ok(backup) => transaction.backups.push(backup),
                    Err(error) => {
                        let restore_error = transaction.restore_backups();
                        return Err(match restore_error {
                            Ok(()) => format!(
                                "Unable to snapshot existing output destination {}: {error}",
                                path.display()
                            ),
                            Err(restore_error) => format!(
                                "Unable to snapshot existing output destination {}: {error}; restoring prior snapshots was incomplete: {restore_error}",
                                path.display()
                            ),
                        });
                    }
                },
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    let restore_error = transaction.restore_backups();
                    return Err(match restore_error {
                        Ok(()) => format!(
                            "Output destination is not a regular file or directory: {}",
                            path.display()
                        ),
                        Err(restore_error) => format!(
                            "Output destination is not a regular file or directory: {}; restoring prior snapshots was incomplete: {restore_error}",
                            path.display()
                        ),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    let restore_error = transaction.restore_backups();
                    return Err(match restore_error {
                        Ok(()) => format!(
                            "Unable to inspect output destination {}: {error}",
                            path.display()
                        ),
                        Err(restore_error) => format!(
                            "Unable to inspect output destination {}: {error}; restoring prior snapshots was incomplete: {restore_error}",
                            path.display()
                        ),
                    });
                }
            }
        }
        Ok(transaction)
    }

    fn restore_backups(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        while let Some(backup) = self.backups.pop() {
            let original = backup.original().to_path_buf();
            if let Err(error) = backup.restore() {
                failures.push(format!("{}: {error}", original.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn commit(self) -> Result<(), String> {
        let mut failures = Vec::new();
        for backup in self.backups {
            let original = backup.original().to_path_buf();
            if let Err(error) = backup.discard() {
                failures.push(format!("{}: {error}", original.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn rollback(mut self) -> Result<(), String> {
        let backed_up = self
            .backups
            .iter()
            .map(|backup| backup.original().to_path_buf())
            .collect::<HashSet<_>>();
        let mut failures = Vec::new();
        for path in &self.destinations {
            if backed_up.contains(path) {
                continue;
            }
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() => continue,
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    continue;
                }
            }
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
        }
        if let Err(error) = self.restore_backups() {
            failures.push(error);
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

pub(super) fn run_manifest_transaction(
    manifest: &ManifestV3,
    operation: impl FnOnce() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let transaction = ManifestPublicationTransaction::begin(manifest).map_err(|error| {
        NativeError::new(
            NativeErrorCode::Io,
            format!("Unable to prepare scan-cleanup output transaction: {error}"),
        )
    })?;
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
        Err(panic) => {
            if let Err(rollback_error) = transaction.rollback() {
                std::panic::resume_unwind(Box::new(format!(
                    "Scan-cleanup batch panicked; rollback was incomplete: {rollback_error}"
                )));
            }
            std::panic::resume_unwind(panic);
        }
        Ok(Ok(())) => transaction.commit().map_err(|error| {
            NativeError::new(
                NativeErrorCode::Io,
                format!("Unable to finalize scan-cleanup output transaction: {error}"),
            )
            .into()
        }),
        Ok(Err(operation_error)) => match transaction.rollback() {
            Ok(()) => Err(operation_error),
            Err(rollback_error) => Err(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!(
                    "Scan-cleanup batch failed ({operation_error}); rollback was incomplete: {rollback_error}"
                ),
            )
            .into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::run_manifest_transaction;
    use crate::{
        protocol::manifest_v3::{
            AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, PageOutput, RenderMode,
            VERSION,
        },
        CleanupOptions,
    };
    use std::{fs, path::Path};

    #[test]
    fn batch_failure_rolls_back_every_declared_destination_across_pages() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-transaction-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.png");
        fs::write(&input, b"input must survive rollback").unwrap();
        let output = |page: usize| PageOutput {
            output_path: dir.join(format!("page-{page}.png")),
            metadata_path: dir.join(format!("page-{page}-output.json")),
            bilevel_output_path: Some(dir.join(format!("page-{page}.pbm"))),
            background_output_path: Some(dir.join(format!("page-{page}-background.png"))),
            foreground_mask_output_path: Some(dir.join(format!("page-{page}-foreground.pbm"))),
            foreground_alpha_output_path: Some(dir.join(format!("page-{page}-foreground.png"))),
            picture_mask_output_path: Some(dir.join(format!("page-{page}-picture.pbm"))),
            tone_preservation_alpha_output_path: Some(dir.join(format!("page-{page}-tone.png"))),
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            pages: (0..2)
                .map(|page| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: page,
                    page_metadata_path: dir.join(format!("page-{page}-page.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: vec![output(page)],
                })
                .collect(),
        };
        let destinations = manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        assert_eq!(destinations.len(), 18);

        let error = run_manifest_transaction(&manifest, || {
            // Page one publishes every raster/layer/metadata role. Page two
            // then leaves a partial publication before processing fails.
            for path in &destinations[..9] {
                fs::write(path, b"page one published")?;
            }
            for path in &destinations[9..12] {
                fs::write(path, b"page two partial")?;
            }
            Err(std::io::Error::other("page two failed").into())
        })
        .unwrap_err();

        assert!(error.to_string().contains("page two failed"));
        assert_eq!(fs::read(&input).unwrap(), b"input must survive rollback");
        for path in &destinations {
            assert!(!path.exists(), "rollback left {}", path.display());
        }

        for (index, path) in destinations.iter().enumerate() {
            fs::write(path, format!("previous destination {index}").as_bytes()).unwrap();
        }
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = run_manifest_transaction(&manifest, || {
                for path in &destinations[..4] {
                    fs::write(path, b"partial replacement")?;
                }
                panic!("page worker panicked");
            });
        }));
        assert_eq!(
            panic
                .expect_err("transaction swallowed the page panic")
                .downcast_ref::<&str>(),
            Some(&"page worker panicked")
        );
        for (index, path) in destinations.iter().enumerate() {
            assert_eq!(
                fs::read(path).unwrap(),
                format!("previous destination {index}").as_bytes()
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
