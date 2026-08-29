use super::*;

pub(crate) fn run(args: Vec<String>) -> Result<()> {
    let config = parse_args(args.into_iter())
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
    mutate_pdf(config)
}

pub(crate) fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config> {
    let command = args.next().ok_or("Missing command")?;
    let mut input_path = None;
    let mut source_path = None;
    let mut output_path = None;
    let mut pages_file = None;
    let mut updates_file = None;
    let mut changes_file = None;
    let mut mutations_file = None;
    let mut identity_bindings_file = None;
    let mut instructions_file = None;
    let mut modified_at = None;
    let mut top = None;
    let mut bottom = None;
    let mut left = None;
    let mut right = None;
    let mut page_number = None;
    let mut qpdf_path = None;
    let mut append = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => {
                input_path = Some(PathBuf::from(args.next().ok_or("Missing --input value")?))
            }
            "--source" => {
                source_path = Some(PathBuf::from(args.next().ok_or("Missing --source value")?))
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
            "--identity-bindings-file" => {
                identity_bindings_file = Some(PathBuf::from(
                    args.next()
                        .ok_or("Missing --identity-bindings-file value")?,
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
            "--page" | "--page-number" => {
                let value = args.next().ok_or("Missing --page value")?;
                let parsed = value.parse::<u32>()?;
                if parsed == 0 {
                    return Err("Page number must be positive".into());
                }
                page_number = Some(parsed);
            }
            "--qpdf" | "--qpdf-path" => {
                qpdf_path = Some(PathBuf::from(args.next().ok_or("Missing --qpdf value")?))
            }
            "--append" => {
                append = true;
            }
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }

    if identity_bindings_file.is_some() && command != "save-mutations" {
        return Err("--identity-bindings-file is only valid for save-mutations".into());
    }

    let operation = match command.as_str() {
        "split-pages" => Operation::SplitPages {
            instructions_file: instructions_file.ok_or("Missing --instructions-file value")?,
        },
        "overlay-text" => Operation::OverlayText {
            source_path: source_path.ok_or("Missing --source value")?,
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
        },
        "save-note-changes" => Operation::SaveNoteChanges {
            changes_file: changes_file.ok_or("Missing --changes-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
        },
        "save-mutations" => Operation::SaveMutations {
            mutations_file: mutations_file.ok_or("Missing --mutations-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            identity_bindings_file,
        },
        "annotation-index" | "annotation-name-index" => Operation::AnnotationNameIndex,
        "embedded-shape-index" | "shape-index" => Operation::EmbeddedShapeIndex,
        "pdf-conformance" | "conformance" => Operation::PdfConformance,
        "page-geometry" | "get-page-geometry" => Operation::PageGeometry {
            page_number: page_number.ok_or("Missing --page value")?,
        },
        "page-sizes" => Operation::PageSizes,
        _ => return Err(format!("Unknown command: {command}").into()),
    };

    Ok(Config {
        operation,
        input_path: input_path.ok_or("Missing --input value")?,
        output_path: output_path.ok_or("Missing --output value")?,
        qpdf_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_page_geometry_request() {
        let config = parse_args(
            [
                "page-geometry",
                "--input",
                "input.pdf",
                "--output",
                "geometry.json",
                "--page",
                "7",
                "--qpdf",
                "qpdf",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();

        assert!(matches!(
            config.operation,
            Operation::PageGeometry { page_number: 7 }
        ));
        assert_eq!(config.input_path, PathBuf::from("input.pdf"));
        assert_eq!(config.output_path, PathBuf::from("geometry.json"));
        assert_eq!(config.qpdf_path, Some(PathBuf::from("qpdf")));
    }

    #[test]
    fn rejects_page_zero_for_page_geometry() {
        let error = parse_args(
            [
                "page-geometry",
                "--input",
                "input.pdf",
                "--output",
                "geometry.json",
                "--page",
                "0",
            ]
            .into_iter()
            .map(String::from),
        )
        .err()
        .expect("page zero should be rejected")
        .to_string();

        assert!(error.contains("Page number must be positive"));
    }
}
