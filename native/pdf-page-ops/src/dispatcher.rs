use super::*;

pub(crate) fn mutate_pdf(config: Config) -> Result<()> {
    match &config.operation {
        Operation::Crop {
            pages_file,
            margins,
        } => {
            let pages = read_pages_file(pages_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_crop_pages_path(
                &config.input_path,
                &config.output_path,
                &pages,
                *margins,
                config.qpdf_path.as_deref(),
            );
        }
        Operation::RemoveCrop { pages_file } => {
            let pages = read_pages_file(pages_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_remove_crop_pages_path(
                &config.input_path,
                &config.output_path,
                &pages,
                config.qpdf_path.as_deref(),
            );
        }
        _ => {}
    }

    match &config.operation {
        Operation::SplitPages { instructions_file } => {
            let instructions = read_split_pages_file(instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_split_pages_path(
                &config.input_path,
                &config.output_path,
                &instructions,
                config.qpdf_path.as_deref(),
            );
        }
        Operation::OverlayText {
            source_path,
            instructions_file,
        } => {
            let instructions = read_text_layer_file(instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_overlay_text_layers_path(
                &config.input_path,
                source_path,
                &config.output_path,
                &instructions,
                config.qpdf_path.as_deref(),
            );
        }
        _ => {}
    }

    match &config.operation {
        Operation::AnnotationNameIndex => {
            return write_annotation_name_index_path(
                &config.input_path,
                &config.output_path,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::EmbeddedShapeIndex => {
            return write_embedded_shape_index_path(
                &config.input_path,
                &config.output_path,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::PageSizes => {
            return write_page_sizes_path(
                &config.input_path,
                &config.output_path,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::PdfConformance => {
            return write_pdf_conformance_path(
                &config.input_path,
                &config.output_path,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::PageGeometry { page_number } => {
            return write_page_geometry_path(
                &config.input_path,
                &config.output_path,
                *page_number,
                config.qpdf_path.as_deref(),
            )
        }
        _ => {}
    }

    let appended = read_append_mutations(&config.operation)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
    if let Some((mutations, modified_at)) = appended {
        return append_native_mutations_with_qpdf(
            &config.input_path,
            &config.output_path,
            &mutations,
            modified_at,
            config.qpdf_path.as_deref(),
        );
    }

    if let Some((mutations, modified_at)) = read_non_append_mutations(&config.operation)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?
    {
        return write_native_mutations_path(
            &config.input_path,
            &config.output_path,
            &mutations,
            modified_at,
            config.qpdf_path.as_deref(),
        );
    }

    unreachable!("all PDF page operations must be dispatched before this point")
}

pub(crate) fn classify_pdf_load_error(error: Box<dyn Error>, context: &str) -> Box<dyn Error> {
    if error.downcast_ref::<NativeError>().is_some() {
        error
    } else {
        domain_error(NativeErrorCode::CorruptXref, format!("{context}: {error}"))
    }
}

/// The three append commands differ only in the payload schema they accept, so
/// they are normalized to one mutation set and share a single append path.
fn read_append_mutations(operation: &Operation) -> Result<Option<(NativeMutationsFile, &str)>> {
    let mutations = match operation {
        Operation::UpdateNoteText {
            updates_file,
            modified_at,
            append: true,
        } => (
            NativeMutationsFile {
                updates: read_note_text_updates(updates_file)?,
                ..NativeMutationsFile::default()
            },
            modified_at.as_str(),
        ),
        Operation::SaveNoteChanges {
            changes_file,
            modified_at,
            append: true,
        } => {
            let changes = read_note_changes(changes_file)?;
            (
                NativeMutationsFile {
                    updates: changes.updates,
                    free_text_notes: changes.free_text_notes,
                    deletes: changes.deletes,
                    ..NativeMutationsFile::default()
                },
                modified_at.as_str(),
            )
        }
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: true,
        } => (read_native_mutations(mutations_file)?, modified_at.as_str()),
        _ => return Ok(None),
    };
    Ok(Some(mutations))
}

fn read_non_append_mutations(operation: &Operation) -> Result<Option<(NativeMutationsFile, &str)>> {
    let mutations = match operation {
        Operation::UpdateNoteText {
            updates_file,
            modified_at,
            append: false,
        } => (
            NativeMutationsFile {
                updates: read_note_text_updates(updates_file)?,
                ..NativeMutationsFile::default()
            },
            modified_at.as_str(),
        ),
        Operation::SaveNoteChanges {
            changes_file,
            modified_at,
            append: false,
        } => {
            let changes = read_note_changes(changes_file)?;
            (
                NativeMutationsFile {
                    updates: changes.updates,
                    free_text_notes: changes.free_text_notes,
                    deletes: changes.deletes,
                    ..NativeMutationsFile::default()
                },
                modified_at.as_str(),
            )
        }
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: false,
        } => (read_native_mutations(mutations_file)?, modified_at.as_str()),
        _ => return Ok(None),
    };
    Ok(Some(mutations))
}
