fn mutate_pdf(config: Config) -> Result<()> {
    if let Operation::UpdateNoteText {
        updates_file,
        modified_at,
        append: true,
    } = &config.operation
    {
        let updates = read_note_text_updates(updates_file)?;
        append_note_text_update(
            &config.input_path,
            &config.output_path,
            &updates,
            modified_at,
        )?;
        return Ok(());
    }
    if let Operation::SaveNoteChanges {
        changes_file,
        modified_at,
        append: true,
    } = &config.operation
    {
        let changes = read_note_changes(changes_file)?;
        append_note_changes(
            &config.input_path,
            &config.output_path,
            &changes,
            modified_at,
        )?;
        return Ok(());
    }
    if let Operation::SaveMutations {
        mutations_file,
        modified_at,
        append: true,
    } = &config.operation
    {
        let mutations = read_native_mutations(mutations_file)?;
        append_native_mutations(
            &config.input_path,
            &config.output_path,
            &mutations,
            modified_at,
        )?;
        return Ok(());
    }

    let mut document = Document::load(&config.input_path)?;
    if document.is_encrypted() {
        return Err("Encrypted PDFs are not supported by native page ops".into());
    }

    match config.operation {
        Operation::Crop {
            pages_file,
            margins,
        } => {
            let pages = read_pages_file(&pages_file)?;
            crop_pages(&mut document, &pages, margins)?;
        }
        Operation::RemoveCrop { pages_file } => {
            let pages = read_pages_file(&pages_file)?;
            remove_crop_from_pages(&mut document, &pages)?;
        }
        Operation::UpdateNoteText {
            updates_file,
            modified_at,
            append: _,
        } => {
            let updates = read_note_text_updates(&updates_file)?;
            update_note_text(&mut document, &updates, &modified_at)?;
        }
        Operation::SaveNoteChanges {
            changes_file,
            modified_at,
            append: _,
        } => {
            let changes = read_note_changes(&changes_file)?;
            update_note_text(&mut document, &changes.updates, &modified_at)?;
            upsert_free_text_notes(&mut document, &changes.free_text_notes, &modified_at)?;
            delete_annotations(&mut document, &changes.deletes)?;
        }
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: _,
        } => {
            let mutations = read_native_mutations(&mutations_file)?;
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
