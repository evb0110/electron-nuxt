mod binary;
mod flate;
mod image;
mod jpeg;
mod netpbm;
mod pdf;
mod png;
mod tiff_io;

use std::{
    env,
    error::Error,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

use crate::{image::read_image_pages, pdf::build_pdf, tiff_io::combine_tiff_pages};

pub(crate) const DEFAULT_DPI: u32 = 72;
pub(crate) const METERS_PER_INCH: f64 = 0.0254;
pub(crate) const CM_PER_INCH: f64 = 2.54;
const VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) type Result<T> = std::result::Result<T, Box<dyn Error>>;

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
        combine_tiff_pages(
            &config.input_paths,
            &config.output_path,
            max_pixels,
            read_limit("EVB_TIFF_COMBINE_MAX_PAGES", 10_000, 1, 100_000) as usize,
        )?;
        return Ok(());
    }

    let max_pages = read_limit("EVB_PDF_COMBINE_MAX_PAGES", 500, 1, 10_000) as usize;
    let max_tiff_frames = read_limit("EVB_PDF_COMBINE_MAX_TIFF_FRAMES", 250, 1, 5_000) as usize;
    let started_at = Instant::now();
    let total = config.input_paths.len();
    let mut pages = Vec::with_capacity(total);

    for (index, input_path) in config.input_paths.iter().enumerate() {
        let input_pages = read_image_pages(input_path, max_pixels, config.dpi, max_tiff_frames)?;
        if pages.len() + input_pages.len() > max_pages {
            return Err(format!("Combined PDF is capped at {max_pages} pages").into());
        }
        pages.extend(input_pages);
        if config.json_progress {
            print_progress(index + 1, total, started_at);
        }
    }

    let pdf = build_pdf(&pages)?;
    fs::write(&config.output_path, pdf)?;
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
