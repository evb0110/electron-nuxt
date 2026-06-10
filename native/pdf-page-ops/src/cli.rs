fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if env::args().skip(1).any(|arg| arg == "--version") {
        println!("evb-pdf-page-ops {VERSION}");
        return Ok(());
    }

    mutate_pdf(parse_args()?)
}

fn parse_args() -> Result<Config> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("Missing command")?;
    let mut input_path = None;
    let mut output_path = None;
    let mut pages_file = None;
    let mut updates_file = None;
    let mut changes_file = None;
    let mut mutations_file = None;
    let mut modified_at = None;
    let mut top = None;
    let mut bottom = None;
    let mut left = None;
    let mut right = None;
    let mut append = false;

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
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }

    let operation = match command.as_str() {
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
