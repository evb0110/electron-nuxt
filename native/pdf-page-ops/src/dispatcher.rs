use super::*;

pub(crate) fn mutate_pdf(config: Config) -> Result<()> {
    if let Operation::UpdateNoteText {
        updates_file,
        modified_at,
        append: true,
        incremental_validation,
    } = &config.operation
    {
        let updates = read_note_text_updates(updates_file)
            .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
        append_note_text_update(
            &config.input_path,
            &config.output_path,
            &updates,
            modified_at,
            *incremental_validation,
        )?;
        return Ok(());
    }
    if let Operation::SaveNoteChanges {
        changes_file,
        modified_at,
        append: true,
        incremental_validation,
    } = &config.operation
    {
        let changes = read_note_changes(changes_file)
            .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
        append_note_changes(
            &config.input_path,
            &config.output_path,
            &changes,
            modified_at,
            *incremental_validation,
        )?;
        return Ok(());
    }
    if let Operation::SaveMutations {
        mutations_file,
        modified_at,
        append: true,
        incremental_validation,
    } = &config.operation
    {
        let mutations = read_native_mutations(mutations_file)
            .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
        append_native_mutations(
            &config.input_path,
            &config.output_path,
            &mutations,
            modified_at,
            *incremental_validation,
        )?;
        return Ok(());
    }

    let mut document = Document::load(&config.input_path).map_err(|error| {
        domain_error(
            NativeErrorCode::CorruptXref,
            format!("Failed to parse PDF structure: {error}"),
        )
    })?;
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
            split_pages(&document, &instructions, &config.output_path)?;
            return Ok(());
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
            incremental_validation: _,
        } => {
            let updates = read_note_text_updates(&updates_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            update_note_text(&mut document, &updates, &modified_at)?;
        }
        Operation::SaveNoteChanges {
            changes_file,
            modified_at,
            append: _,
            incremental_validation: _,
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
            incremental_validation: _,
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
