use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

use evb_pdf_image_combine::{
    combine_tiff_paths, encode_netpbm_path_as_png, write_pdf_from_image_paths_with_progress,
    PdfBuildOptions, Result,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Config {
    output_path: PathBuf,
    input_paths: Vec<PathBuf>,
    json_progress: bool,
    dpi: Option<u32>,
    output_format: OutputFormat,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputFormat {
    Pdf,
    Png,
    Tiff,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if env::args().skip(1).any(|arg| arg == "--version") {
        println!("evb-pdf-image-combine {VERSION}");
        return Ok(());
    }

    let config = parse_args()?;
    let max_pixels = read_limit(
        "EVB_PDF_COMBINE_MAX_IMAGE_PIXELS",
        80_000_000,
        1_000_000,
        u64::MAX,
    );

    if config.output_format == OutputFormat::Tiff {
        combine_tiff_paths(
            &config.input_paths,
            &config.output_path,
            max_pixels,
            read_limit("EVB_TIFF_COMBINE_MAX_PAGES", 10_000, 1, 100_000) as usize,
        )?;
        return Ok(());
    }
    if config.output_format == OutputFormat::Png {
        if config.input_paths.len() != 1 {
            return Err("PNG output requires exactly one Netpbm input".into());
        }
        encode_netpbm_path_as_png(&config.input_paths[0], &config.output_path)?;
        return Ok(());
    }

    let started_at = Instant::now();
    let total = config.input_paths.len();
    write_pdf_from_image_paths_with_progress(
        &config.input_paths,
        &config.output_path,
        &PdfBuildOptions {
            default_dpi: config.dpi,
            max_pages: read_limit("EVB_PDF_COMBINE_MAX_PAGES", 500, 1, 10_000) as usize,
            max_pixels,
            max_tiff_frames: read_limit("EVB_PDF_COMBINE_MAX_TIFF_FRAMES", 250, 1, 5_000) as usize,
        },
        |processed| {
            if config.json_progress {
                print_progress(processed, total, started_at);
            }
        },
    )?;
    Ok(())
}

fn parse_args() -> Result<Config> {
    let mut args = env::args().skip(1);
    let mut output_path: Option<PathBuf> = None;
    let mut input_paths: Vec<PathBuf> = Vec::new();
    let mut json_progress = false;
    let mut dpi = None;
    let mut output_format = OutputFormat::Pdf;
    let mut reading_inputs = false;

    while let Some(arg) = args.next() {
        if reading_inputs {
            input_paths.push(PathBuf::from(arg));
            continue;
        }

        match arg.as_str() {
            "--output" => {
                let value = args.next().ok_or("Missing --output value")?;
                output_path = Some(PathBuf::from(value));
            }
            "--json-progress" => {
                json_progress = true;
            }
            "--dpi" => {
                let value = args.next().ok_or("Missing --dpi value")?;
                dpi = Some(parse_dpi(&value)?);
            }
            "--format" => {
                let value = args.next().ok_or("Missing --format value")?;
                output_format = match value.as_str() {
                    "pdf" => OutputFormat::Pdf,
                    "png" => OutputFormat::Png,
                    "tiff" => OutputFormat::Tiff,
                    _ => return Err(format!("Unsupported output format: {value}").into()),
                };
            }
            "--inputs-file" => {
                let value = args.next().ok_or("Missing --inputs-file value")?;
                input_paths.extend(read_input_paths_file(Path::new(&value))?);
            }
            "--" => {
                reading_inputs = true;
            }
            _ if arg.starts_with('-') => {
                return Err(format!("Unknown argument: {arg}").into());
            }
            _ => {
                input_paths.push(PathBuf::from(arg));
            }
        }
    }

    let output_path = output_path.ok_or("Missing required --output argument")?;
    if input_paths.is_empty() {
        return Err("At least one input image is required".into());
    }

    Ok(Config {
        output_path,
        input_paths,
        json_progress,
        dpi,
        output_format,
    })
}

fn read_input_paths_file(path: &Path) -> Result<Vec<PathBuf>> {
    let contents = fs::read_to_string(path)?;
    Ok(contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn parse_dpi(value: &str) -> Result<u32> {
    let dpi = value.parse::<u32>()?;
    if dpi == 0 {
        return Err("DPI must be greater than zero".into());
    }
    Ok(dpi)
}

fn read_limit(name: &str, default_value: u64, min_value: u64, max_value: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= min_value && *value <= max_value)
        .unwrap_or(default_value)
}

fn print_progress(processed: usize, total: usize, started_at: Instant) {
    let elapsed_ms = started_at.elapsed().as_millis() as u64;
    let percent = ((processed as f64 / total as f64) * 100.0).round() as u32;
    let estimated_remaining_ms = if processed >= total {
        0
    } else {
        let average = elapsed_ms as f64 / processed.max(1) as f64;
        (average * (total - processed) as f64).round() as u64
    };

    println!(
        "{{\"type\":\"progress\",\"processed\":{processed},\"total\":{total},\"percent\":{percent},\"elapsedMs\":{elapsed_ms},\"estimatedRemainingMs\":{estimated_remaining_ms}}}"
    );
    let _ = std::io::stdout().flush();
}
