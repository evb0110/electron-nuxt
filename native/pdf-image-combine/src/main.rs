use std::{
    env, fs,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::Instant,
};

use evb_native_support::{
    generated_native_tool_protocols::PDF_IMAGE_COMBINE,
    output::{AtomicOutput, ValidatedInputFiles},
};
use evb_pdf_image_combine::{
    combine_tiff_paths, encode_netpbm_path_as_png, probe_netpbm_path, write_pdf, FramePolicy,
    ImageCompression, ImageProcessing, ImageSpec, InputSource, JpegSizeGuardrail, PageSpec,
    PdfBuildOptions, PdfPageSize, Result, DEFAULT_MAX_BILEVEL_PIXELS, DEFAULT_MAX_IMAGE_PIXELS,
};

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
    evb_native_support::run_native_cli(
        PDF_IMAGE_COMBINE,
        env!("CARGO_PKG_VERSION"),
        env::args().skip(1),
        run,
    );
}

fn run(raw_args: Vec<String>) -> Result<()> {
    if raw_args.first().is_some_and(|arg| arg == "--probe-netpbm") {
        let input_path = raw_args.get(1).ok_or("Missing --probe-netpbm input path")?;
        if raw_args.len() != 2 {
            return Err("--probe-netpbm accepts exactly one input path".into());
        }
        let probe = probe_netpbm_path(
            Path::new(input_path),
            read_limit(
                "EVB_PDF_COMBINE_MAX_IMAGE_PIXELS",
                DEFAULT_MAX_IMAGE_PIXELS,
                1_000_000,
                u64::MAX,
            ),
        )?;
        println!("{}", serde_json::to_string(&probe)?);
        return Ok(());
    }
    let config = parse_args(raw_args.into_iter())?;
    let max_pixels = read_limit(
        "EVB_PDF_COMBINE_MAX_IMAGE_PIXELS",
        DEFAULT_MAX_IMAGE_PIXELS,
        1_000_000,
        u64::MAX,
    );
    let max_total_pixels = read_limit(
        "EVB_PDF_COMBINE_MAX_TOTAL_PIXELS",
        512_000_000,
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

    let page_specs = if let Some(manifest_path) = &config.compact_manifest_path {
        read_compact_manifest(manifest_path)?
    } else {
        config
            .input_paths
            .iter()
            .cloned()
            .map(|source| PageSpec::Image {
                page_size: None,
                image: ImageSpec {
                    source,
                    compression: ImageCompression::Auto,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                frames: FramePolicy::All,
            })
            .collect()
    };
    let total = page_specs.len();
    let started_at = Instant::now();
    write_pdf_file(
        page_specs,
        &config.output_path,
        &PdfBuildOptions {
            default_dpi: config.dpi,
            max_pages: read_limit("EVB_PDF_COMBINE_MAX_PAGES", 500, 1, 10_000) as usize,
            max_pixels,
            max_bilevel_pixels: DEFAULT_MAX_BILEVEL_PIXELS,
            max_total_pixels,
            max_output_bytes: read_limit(
                "EVB_PDF_COMBINE_MAX_OUTPUT_BYTES",
                512 * 1024 * 1024,
                1024 * 1024,
                u64::MAX,
            ),
            max_tiff_frames: read_limit("EVB_PDF_COMBINE_MAX_TIFF_FRAMES", 250, 1, 5_000) as usize,
        },
        |processed| {
            if config.json_progress {
                print_progress(processed, total, started_at);
            }
        },
    )
}

fn write_pdf_file(
    page_specs: Vec<PageSpec<PathBuf>>,
    output_path: &Path,
    options: &PdfBuildOptions,
    on_processed: impl FnMut(usize),
) -> Result<()> {
    if page_specs.is_empty() {
        return Err("At least one image input is required".into());
    }
    let mut paths = Vec::new();
    for spec in &page_specs {
        match spec {
            PageSpec::Image { image, .. } => paths.push(image.source.clone()),
            PageSpec::Layered {
                background,
                foreground_mask,
                ..
            } => {
                paths.push(background.source.clone());
                paths.push(foreground_mask.clone());
            }
            PageSpec::Mask {
                foreground_mask, ..
            } => paths.push(foreground_mask.clone()),
        }
    }

    let validated = ValidatedInputFiles::open(&paths, output_path)?;
    let mut input_index = 0usize;
    let page_specs = page_specs
        .into_iter()
        .map(|spec| {
            spec.map_sources(&mut |label| {
                let file = validated.clone_file(input_index)?;
                input_index += 1;
                Ok::<_, std::io::Error>(InputSource::File { label, file })
            })
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut output = AtomicOutput::create(output_path)?;
    {
        let writer = BufWriter::new(output.file_mut()?);
        let mut writer = write_pdf(writer, page_specs, options, on_processed)?;
        writer.flush()?;
    }
    output.publish()?;
    Ok(())
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config> {
    let mut output_path = None;
    let mut input_paths = Vec::new();
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
                output_path = Some(PathBuf::from(args.next().ok_or("Missing --output value")?))
            }
            "--json-progress" => json_progress = true,
            "--dpi" => dpi = Some(parse_dpi(&args.next().ok_or("Missing --dpi value")?)?),
            "--format" => {
                output_format = match args.next().ok_or("Missing --format value")?.as_str() {
                    "pdf" => OutputFormat::Pdf,
                    "png" => OutputFormat::Png,
                    "tiff" => OutputFormat::Tiff,
                    value => return Err(format!("Unsupported output format: {value}").into()),
                }
            }
            "--inputs-file" => {
                let value = args.next().ok_or("Missing --inputs-file value")?;
                input_paths.extend(read_input_paths_file(Path::new(&value))?);
            }
            "--compact-manifest" => {
                compact_manifest_path = Some(PathBuf::from(
                    args.next().ok_or("Missing --compact-manifest value")?,
                ));
            }
            "--" => reading_inputs = true,
            _ if arg.starts_with('-') => return Err(format!("Unknown argument: {arg}").into()),
            _ => input_paths.push(PathBuf::from(arg)),
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
    Ok(fs::read_to_string(path)?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn read_compact_manifest(path: &Path) -> Result<Vec<PageSpec<PathBuf>>> {
    let contents = fs::read_to_string(path)?;
    let mut page_specs = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        if !line.trim().is_empty() {
            let page = page_specs.len() + 1;
            page_specs.push(parse_compact_manifest_line(line, index + 1, page)?);
        }
    }
    Ok(page_specs)
}

fn parse_compact_manifest_line(
    line: &str,
    line_number: usize,
    page_number: usize,
) -> Result<PageSpec<PathBuf>> {
    let parts = line.split('\t').collect::<Vec<_>>();
    let kind = parts
        .first()
        .copied()
        .ok_or_else(|| format!("Invalid compact manifest line {line_number}"))?;
    let page_size = PdfPageSize {
        width_points: parse_positive_f64(parts.get(1).copied(), "width points", line_number)?,
        height_points: parse_positive_f64(parts.get(2).copied(), "height points", line_number)?,
    };
    let image = |source, compression, processing, size_guardrail| PageSpec::Image {
        page_size: Some(page_size),
        image: ImageSpec {
            source,
            compression,
            processing,
            size_guardrail,
        },
        frames: FramePolicy::ExactlyOne,
    };
    let source = |index| parse_manifest_path(parts[index], line_number);

    match kind {
        "image" | "image-bilevel" if parts.len() == 4 => Ok(image(
            source(3)?,
            ImageCompression::Auto,
            ImageProcessing::None,
            None,
        )),
        "image-jpeg" if parts.len() == 5 => Ok(image(
            source(4)?,
            ImageCompression::JpegWithFlateFallback {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            ImageProcessing::None,
            None,
        )),
        "photo-jpeg" if parts.len() == 6 || parts.len() == 7 => Ok(image(
            source(parts.len() - 1)?,
            ImageCompression::Jpeg {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            ImageProcessing::DownscaleToPpi {
                ppi_cap: parse_u16_range(
                    parts.get(4).copied(),
                    "photo PPI cap",
                    line_number,
                    1,
                    1200,
                )?,
            },
            Some(JpegSizeGuardrail {
                page: page_number,
                log_json_progress: true,
            }),
        )),
        "layered" if parts.len() == 5 => Ok(PageSpec::Layered {
            page_size,
            background: image_spec(source(3)?, ImageCompression::Auto),
            foreground_mask: source(4)?,
            foreground_color: None,
        }),
        "layered-jpeg" if parts.len() == 6 => Ok(PageSpec::Layered {
            page_size,
            background: image_spec(
                source(4)?,
                ImageCompression::JpegWithFlateFallback {
                    quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
                },
            ),
            foreground_mask: source(5)?,
            foreground_color: None,
        }),
        "layered-color-jpeg" if parts.len() == 9 => Ok(PageSpec::Layered {
            page_size,
            background: image_spec(
                source(4)?,
                ImageCompression::JpegWithFlateFallback {
                    quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
                },
            ),
            foreground_mask: source(5)?,
            foreground_color: Some([
                parse_u8_range(parts.get(6).copied(), "foreground red", line_number)?,
                parse_u8_range(parts.get(7).copied(), "foreground green", line_number)?,
                parse_u8_range(parts.get(8).copied(), "foreground blue", line_number)?,
            ]),
        }),
        "mask" if parts.len() == 4 => Ok(PageSpec::Mask {
            page_size,
            foreground_mask: source(3)?,
        }),
        "image" | "image-bilevel" | "image-jpeg" | "photo-jpeg" | "layered" | "layered-jpeg"
        | "layered-color-jpeg" | "mask" => {
            Err(format!("Invalid compact manifest field count on line {line_number}").into())
        }
        _ => {
            Err(format!("Invalid compact manifest page kind on line {line_number}: {kind}").into())
        }
    }
}

fn image_spec(source: PathBuf, compression: ImageCompression) -> ImageSpec<PathBuf> {
    ImageSpec {
        source,
        compression,
        processing: ImageProcessing::None,
        size_guardrail: None,
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
    value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<u8>()
        .map_err(Into::into)
}

fn parse_manifest_path(value: &str, line_number: usize) -> Result<PathBuf> {
    if value.is_empty() || value.trim() != value || value.contains(['\r', '\n']) {
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
    fn parses_all_compact_page_shapes_into_page_specs() {
        let cases = [
            "image\t72\t144\t/tmp/page.ppm",
            "image-bilevel\t72\t144\t/tmp/page.pbm",
            "image-jpeg\t72\t144\t82\t/tmp/page.ppm",
            "photo-jpeg\t72\t144\t85\t300\t/tmp/photo.ppm",
            "layered\t72\t144\t/tmp/background.ppm\t/tmp/mask.pbm",
            "layered-jpeg\t72\t144\t82\t/tmp/bg.ppm\t/tmp/mask.pbm",
            "layered-color-jpeg\t72\t144\t82\t/tmp/bg.ppm\t/tmp/mask.pbm\t128\t16\t16",
            "mask\t72\t144\t/tmp/mask.pbm",
        ];
        for (index, line) in cases.into_iter().enumerate() {
            parse_compact_manifest_line(line, index + 1, index + 1).unwrap();
        }
    }

    #[test]
    fn rejects_invalid_compact_manifest_lines() {
        for (index, line) in [
            "layered\t0\t144\t/tmp/bg.ppm\t/tmp/mask.pbm",
            "image\t72\t144\t/tmp/page.ppm ",
            "mask\t72\t144",
            "image-jpeg\t72\t144\t0\t/tmp/page.ppm",
            "unknown\t72\t144\t/tmp/page.ppm",
            "photo-jpeg\t72\t144\t75\t0\t/tmp/page.ppm",
        ]
        .into_iter()
        .enumerate()
        {
            assert!(parse_compact_manifest_line(line, index + 1, index + 1).is_err());
        }
    }
}
