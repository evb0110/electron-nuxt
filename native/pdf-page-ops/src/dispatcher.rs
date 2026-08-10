use super::*;

pub(crate) fn mutate_pdf(config: Config) -> Result<()> {
    let appended = read_append_mutations(&config.operation)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
    if let Some((mutations, modified_at)) = appended {
        return append_native_mutations(
            &config.input_path,
            &config.output_path,
            &mutations,
            modified_at,
        );
    }

    let mut document = load_pdf_path(&config.input_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    if document.is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by native page ops",
        ));
    }

    match config.operation {
        Operation::SplitPages { instructions_file } => {
            let instructions = read_split_pages_file(&instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            split_pages(document, &instructions, &config.output_path)?;
            return Ok(());
        }
        Operation::OverlayText {
            source_path,
            instructions_file,
        } => {
            let source = load_pdf_path(&source_path).map_err(|error| {
                classify_pdf_load_error(error, "Failed to parse source PDF structure")
            })?;
            if source.is_encrypted() {
                return Err(domain_error(
                    NativeErrorCode::Encrypted,
                    "Encrypted source PDFs are not supported by native page ops",
                ));
            }
            let instructions = read_text_layer_file(&instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            overlay_text_layers(&mut document, &source, &instructions)?;
        }
        Operation::Crop {
            pages_file,
            margins,
        } => {
            let pages = read_pages_file(&pages_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            crop_pages(&mut document, &pages, margins)?;
        }
        Operation::RemoveCrop { pages_file } => {
            let pages = read_pages_file(&pages_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            remove_crop_from_pages(&mut document, &pages)?;
        }
        Operation::UpdateNoteText {
            updates_file,
            modified_at,
            append: _,
        } => {
            let updates = read_note_text_updates(&updates_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            update_note_text(&mut document, &updates, &modified_at)?;
        }
        Operation::SaveNoteChanges {
            changes_file,
            modified_at,
            append: _,
        } => {
            let changes = read_note_changes(&changes_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            update_note_text(&mut document, &changes.updates, &modified_at)?;
            upsert_free_text_notes(&mut document, &changes.free_text_notes, &modified_at)?;
            delete_annotations(&mut document, &changes.deletes)?;
        }
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: _,
        } => {
            let mutations = read_native_mutations(&mutations_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            apply_native_mutations(&mut document, &mutations, &modified_at)?;
        }
        Operation::PageSizes => {
            write_page_sizes_json(&document, &config.output_path)?;
            return Ok(());
        }
    }

    document.save(&config.output_path)?;
    Ok(())
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
