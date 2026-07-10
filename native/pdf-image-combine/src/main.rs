use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

use evb_pdf_image_combine::{
    combine_tiff_paths, encode_netpbm_path_as_png, write_mixed_pdf_from_page_specs_with_progress,
    write_pdf_from_image_paths_with_progress, MixedPdfImageCompression, MixedPdfImageProcessing,
    MixedPdfPageSpec, PdfBuildOptions, PdfPageSize, Result,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: u32 = 3;

struct Config {
    output_path: PathBuf,
    input_paths: Vec<PathBuf>,
    json_progress: bool,
    dpi: Option<u32>,
    output_format: OutputFormat,
    compact_manifest_path: Option<PathBuf>,
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
    if env::args().skip(1).any(|arg| arg == "--protocol-version") {
        println!("{PROTOCOL_VERSION}");
        return Ok(());
    }

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
        encode_netpbm_path_as_png(&config.input_paths[0], &config.output_path, max_pixels)?;
        return Ok(());
    }

    let started_at = Instant::now();
    if let Some(manifest_path) = &config.compact_manifest_path {
        let page_specs = read_compact_manifest(manifest_path)?;
        let total = page_specs.len();
        write_mixed_pdf_from_page_specs_with_progress(
            &page_specs,
            &config.output_path,
            &PdfBuildOptions {
                default_dpi: config.dpi,
                max_pages: read_limit("EVB_PDF_COMBINE_MAX_PAGES", 500, 1, 10_000) as usize,
                max_pixels,
                max_tiff_frames: read_limit("EVB_PDF_COMBINE_MAX_TIFF_FRAMES", 250, 1, 5_000)
                    as usize,
            },
            |processed| {
                if config.json_progress {
                    print_progress(processed, total, started_at);
                }
            },
        )?;
        return Ok(());
    }

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
    let mut compact_manifest_path = None;
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
            "--compact-manifest" => {
                let value = args.next().ok_or("Missing --compact-manifest value")?;
                compact_manifest_path = Some(PathBuf::from(value));
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
    if input_paths.is_empty() && compact_manifest_path.is_none() {
        return Err("At least one input image is required".into());
    }
    if compact_manifest_path.is_some() && output_format != OutputFormat::Pdf {
        return Err("--compact-manifest is only supported for PDF output".into());
    }

    Ok(Config {
        output_path,
        input_paths,
        json_progress,
        dpi,
        output_format,
        compact_manifest_path,
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

fn read_compact_manifest(path: &Path) -> Result<Vec<MixedPdfPageSpec>> {
    let contents = fs::read_to_string(path)?;
    let mut page_specs = Vec::new();

    for (index, line) in contents.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        page_specs.push(parse_compact_manifest_line(line, index + 1)?);
    }

    Ok(page_specs)
}

fn parse_compact_manifest_line(line: &str, line_number: usize) -> Result<MixedPdfPageSpec> {
    let parts = line.split('\t').collect::<Vec<_>>();
    let kind = parts
        .first()
        .copied()
        .ok_or_else(|| format!("Invalid compact manifest line {line_number}"))?;
    let page_size = PdfPageSize {
        width_points: parse_positive_f64(parts.get(1).copied(), "width points", line_number)?,
        height_points: parse_positive_f64(parts.get(2).copied(), "height points", line_number)?,
    };

    match kind {
        "image" if parts.len() == 4 => Ok(MixedPdfPageSpec::FullImage {
            page_size,
            image_path: parse_manifest_path(parts[3], line_number)?,
            compression: MixedPdfImageCompression::Auto,
            image_processing: MixedPdfImageProcessing::None,
            size_guardrail: false,
        }),
        "image-jpeg" if parts.len() == 5 => Ok(MixedPdfPageSpec::FullImage {
            page_size,
            compression: MixedPdfImageCompression::Jpeg {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            image_path: parse_manifest_path(parts[4], line_number)?,
            image_processing: MixedPdfImageProcessing::None,
            size_guardrail: false,
        }),
        "photo-jpeg" if parts.len() == 6 || parts.len() == 7 => Ok(MixedPdfPageSpec::FullImage {
            page_size,
            compression: MixedPdfImageCompression::Jpeg {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            image_processing: MixedPdfImageProcessing::DownscaleToPpi {
                ppi_cap: parse_u16_range(
                    parts.get(4).copied(),
                    "photo PPI cap",
                    line_number,
                    1,
                    1200,
                )?,
            },
            size_guardrail: true,
            image_path: parse_manifest_path(parts[parts.len() - 1], line_number)?,
        }),
        "layered" if parts.len() == 5 => Ok(MixedPdfPageSpec::Layered {
            page_size,
            background_path: parse_manifest_path(parts[3], line_number)?,
            foreground_mask_path: parse_manifest_path(parts[4], line_number)?,
            foreground_color: None,
            background_compression: MixedPdfImageCompression::Auto,
            background_processing: MixedPdfImageProcessing::None,
            size_guardrail: false,
        }),
        "layered-jpeg" if parts.len() == 6 => Ok(MixedPdfPageSpec::Layered {
            page_size,
            background_compression: MixedPdfImageCompression::Jpeg {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            background_path: parse_manifest_path(parts[4], line_number)?,
            foreground_mask_path: parse_manifest_path(parts[5], line_number)?,
            foreground_color: None,
            background_processing: MixedPdfImageProcessing::None,
            size_guardrail: false,
        }),
        "layered-color-jpeg" if parts.len() == 9 => Ok(MixedPdfPageSpec::Layered {
            page_size,
            background_compression: MixedPdfImageCompression::Jpeg {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            background_path: parse_manifest_path(parts[4], line_number)?,
            foreground_mask_path: parse_manifest_path(parts[5], line_number)?,
            foreground_color: Some([
                parse_u8_range(parts.get(6).copied(), "foreground red", line_number)?,
                parse_u8_range(parts.get(7).copied(), "foreground green", line_number)?,
                parse_u8_range(parts.get(8).copied(), "foreground blue", line_number)?,
            ]),
            background_processing: MixedPdfImageProcessing::None,
            size_guardrail: false,
        }),
        "mask" if parts.len() == 4 => Ok(MixedPdfPageSpec::MaskOnly {
            page_size,
            foreground_mask_path: parse_manifest_path(parts[3], line_number)?,
        }),
        "image" | "image-jpeg" | "photo-jpeg" | "layered" | "layered-jpeg"
        | "layered-color-jpeg" | "mask" => {
            Err(format!("Invalid compact manifest field count on line {line_number}").into())
        }
        _ => {
            Err(format!("Invalid compact manifest page kind on line {line_number}: {kind}").into())
        }
    }
}

fn parse_positive_f64(value: Option<&str>, label: &str, line_number: usize) -> Result<f64> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<f64>()?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err(format!("Invalid {label} on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_jpeg_quality(value: Option<&str>, line_number: usize) -> Result<u8> {
    let parsed = value
        .ok_or_else(|| format!("Missing JPEG quality on compact manifest line {line_number}"))?
        .parse::<u8>()?;
    if !(1..=100).contains(&parsed) {
        return Err(format!("Invalid JPEG quality on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_u16_range(
    value: Option<&str>,
    label: &str,
    line_number: usize,
    min_value: u16,
    max_value: u16,
) -> Result<u16> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<u16>()?;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid {label} on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_u8_range(value: Option<&str>, label: &str, line_number: usize) -> Result<u8> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<u8>()?;
    Ok(parsed)
}

fn parse_manifest_path(value: &str, line_number: usize) -> Result<PathBuf> {
    if value.is_empty() || value.trim() != value || value.contains('\r') || value.contains('\n') {
        return Err(format!("Invalid path on compact manifest line {line_number}").into());
    }
    Ok(PathBuf::from(value))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_compact_manifest_layered_and_image_lines() {
        let layered =
            parse_compact_manifest_line("layered\t72\t144\t/tmp/background.ppm\t/tmp/mask.pbm", 1)
                .unwrap();
        match layered {
            MixedPdfPageSpec::Layered {
                page_size,
                background_path,
                foreground_mask_path,
                ..
            } => {
                assert_eq!(page_size.width_points, 72.0);
                assert_eq!(page_size.height_points, 144.0);
                assert_eq!(background_path, PathBuf::from("/tmp/background.ppm"));
                assert_eq!(foreground_mask_path, PathBuf::from("/tmp/mask.pbm"));
            }
            MixedPdfPageSpec::FullImage { .. } | MixedPdfPageSpec::MaskOnly { .. } => {
                panic!("expected layered page")
            }
        }

        let image = parse_compact_manifest_line("image\t72\t144\t/tmp/page.ppm", 2).unwrap();
        match image {
            MixedPdfPageSpec::FullImage {
                page_size,
                image_path,
                ..
            } => {
                assert_eq!(page_size.width_points, 72.0);
                assert_eq!(page_size.height_points, 144.0);
                assert_eq!(image_path, PathBuf::from("/tmp/page.ppm"));
            }
            MixedPdfPageSpec::Layered { .. } | MixedPdfPageSpec::MaskOnly { .. } => {
                panic!("expected image page")
            }
        }

        let mask = parse_compact_manifest_line("mask\t72\t144\t/tmp/mask.pbm", 3).unwrap();
        match mask {
            MixedPdfPageSpec::MaskOnly {
                page_size,
                foreground_mask_path,
                ..
            } => {
                assert_eq!(page_size.width_points, 72.0);
                assert_eq!(page_size.height_points, 144.0);
                assert_eq!(foreground_mask_path, PathBuf::from("/tmp/mask.pbm"));
            }
            MixedPdfPageSpec::FullImage { .. } | MixedPdfPageSpec::Layered { .. } => {
                panic!("expected mask page")
            }
        }

        let jpeg =
            parse_compact_manifest_line("layered-jpeg\t72\t144\t82\t/tmp/bg.ppm\t/tmp/mask.pbm", 4)
                .unwrap();
        match jpeg {
            MixedPdfPageSpec::Layered {
                background_compression,
                ..
            } => match background_compression {
                MixedPdfImageCompression::Jpeg { quality } => assert_eq!(quality, 82),
                MixedPdfImageCompression::Auto => panic!("expected jpeg compression"),
            },
            MixedPdfPageSpec::FullImage { .. } | MixedPdfPageSpec::MaskOnly { .. } => {
                panic!("expected layered jpeg page")
            }
        }

        let layered_color = parse_compact_manifest_line(
            "layered-color-jpeg\t72\t144\t82\t/tmp/bg.ppm\t/tmp/mask.pbm\t128\t16\t16",
            5,
        )
        .unwrap();
        match layered_color {
            MixedPdfPageSpec::Layered {
                foreground_color, ..
            } => {
                assert_eq!(foreground_color, Some([128, 16, 16]));
            }
            MixedPdfPageSpec::FullImage { .. } | MixedPdfPageSpec::MaskOnly { .. } => {
                panic!("expected layered color jpeg page")
            }
        }

        let photo =
            parse_compact_manifest_line("photo-jpeg\t72\t144\t85\t300\t/tmp/photo.ppm", 6).unwrap();
        match photo {
            MixedPdfPageSpec::FullImage {
                compression,
                image_processing,
                size_guardrail,
                image_path,
                ..
            } => {
                match compression {
                    MixedPdfImageCompression::Jpeg { quality } => assert_eq!(quality, 85),
                    MixedPdfImageCompression::Auto => panic!("expected jpeg compression"),
                }
                assert_eq!(
                    image_processing,
                    MixedPdfImageProcessing::DownscaleToPpi { ppi_cap: 300 }
                );
                assert!(size_guardrail);
                assert_eq!(image_path, PathBuf::from("/tmp/photo.ppm"));
            }
            MixedPdfPageSpec::Layered { .. } | MixedPdfPageSpec::MaskOnly { .. } => {
                panic!("expected photo jpeg page")
            }
        }
    }

    #[test]
    fn rejects_invalid_compact_manifest_lines() {
        assert!(
            parse_compact_manifest_line("layered\t0\t144\t/tmp/bg.ppm\t/tmp/mask.pbm", 1).is_err()
        );
        assert!(parse_compact_manifest_line(
            "image\t72\t144\t/tmp/page with trailing space.ppm ",
            2,
        )
        .is_err());
        assert!(parse_compact_manifest_line("mask\t72\t144", 3).is_err());
        assert!(parse_compact_manifest_line("image-jpeg\t72\t144\t0\t/tmp/page.ppm", 4).is_err());
        assert!(parse_compact_manifest_line("unknown\t72\t144\t/tmp/page.ppm", 5).is_err());
        assert!(
            parse_compact_manifest_line("photo-jpeg\t72\t144\t75\t0\t0\t/tmp/page.ppm", 6).is_err()
        );
        assert!(
            parse_compact_manifest_line("mask-enhanced\t72\t144\t257\t/tmp/mask.pbm", 7,).is_err()
        );
    }
}
