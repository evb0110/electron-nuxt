use super::*;

pub(crate) fn run(args: Vec<String>) -> Result<()> {
    let config = parse_args(args.into_iter())
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
    mutate_pdf(config)
}

pub(crate) fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config> {
    let command = args.next().ok_or("Missing command")?;
    let mut input_path = None;
    let mut output_path = None;
    let mut pages_file = None;
    let mut updates_file = None;
    let mut changes_file = None;
    let mut mutations_file = None;
    let mut instructions_file = None;
    let mut modified_at = None;
    let mut top = None;
    let mut bottom = None;
    let mut left = None;
    let mut right = None;
    let mut append = false;
    let mut incremental_validation = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => {
                input_path = Some(PathBuf::from(args.next().ok_or("Missing --input value")?))
            }
            "--output" => {
                output_path = Some(PathBuf::from(args.next().ok_or("Missing --output value")?))
            }
            "--pages-file" => {
                pages_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --pages-file value")?,
                ))
            }
            "--updates-file" => {
                updates_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --updates-file value")?,
                ))
            }
            "--changes-file" => {
                changes_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --changes-file value")?,
                ))
            }
            "--mutations-file" => {
                mutations_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --mutations-file value")?,
                ))
            }
            "--instructions-file" => {
                instructions_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --instructions-file value")?,
                ))
            }
            "--modified-at" => {
                modified_at = Some(args.next().ok_or("Missing --modified-at value")?)
            }
            "--top" => {
                top = Some(parse_margin(
                    &args.next().ok_or("Missing --top value")?,
                    "top",
                )?)
            }
            "--bottom" => {
                bottom = Some(parse_margin(
                    &args.next().ok_or("Missing --bottom value")?,
                    "bottom",
                )?)
            }
            "--left" => {
                left = Some(parse_margin(
                    &args.next().ok_or("Missing --left value")?,
                    "left",
                )?)
            }
            "--right" => {
                right = Some(parse_margin(
                    &args.next().ok_or("Missing --right value")?,
                    "right",
                )?)
            }
            "--append" => {
                append = true;
            }
            "--incremental-validation" => {
                incremental_validation = Some(
                    match args
                        .next()
                        .ok_or("Missing --incremental-validation value")?
                        .as_str()
                    {
                        "full" => IncrementalValidationMode::Full,
                        "tail-only" => IncrementalValidationMode::TailOnly,
                        value => {
                            return Err(
                                format!("Invalid --incremental-validation value: {value}").into()
                            );
                        }
                    },
                );
            }
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }

    let supports_append = matches!(
        command.as_str(),
        "update-note-text" | "save-note-changes" | "save-mutations"
    );
    if incremental_validation.is_some() && (!supports_append || !append) {
        return Err("--incremental-validation requires an append operation".into());
    }
    let incremental_validation = resolve_incremental_validation_mode(incremental_validation);

    let operation = match command.as_str() {
        "split-pages" => Operation::SplitPages {
            instructions_file: instructions_file.ok_or("Missing --instructions-file value")?,
        },
        "crop" => Operation::Crop {
            pages_file: pages_file.ok_or("Missing --pages-file value")?,
            margins: CropMargins {
                top: top.ok_or("Missing --top value")?,
                bottom: bottom.ok_or("Missing --bottom value")?,
                left: left.ok_or("Missing --left value")?,
                right: right.ok_or("Missing --right value")?,
            },
        },
        "remove-crop" => Operation::RemoveCrop {
            pages_file: pages_file.ok_or("Missing --pages-file value")?,
        },
        "update-note-text" => Operation::UpdateNoteText {
            updates_file: updates_file.ok_or("Missing --updates-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            incremental_validation,
        },
        "save-note-changes" => Operation::SaveNoteChanges {
            changes_file: changes_file.ok_or("Missing --changes-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            incremental_validation,
        },
        "save-mutations" => Operation::SaveMutations {
            mutations_file: mutations_file.ok_or("Missing --mutations-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            incremental_validation,
        },
        "page-sizes" => Operation::PageSizes,
        _ => return Err(format!("Unknown command: {command}").into()),
    };

    Ok(Config {
        operation,
        input_path: input_path.ok_or("Missing --input value")?,
        output_path: output_path.ok_or("Missing --output value")?,
    })
}
