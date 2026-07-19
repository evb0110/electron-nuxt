use crate::{
    pipeline::{clean_page_with_color, CleanupMetadata},
    png::{self, RgbImage},
    CleanupOptions, OrthogonalRotation, OutputMode, PROTOCOL_VERSION,
};
use evb_native_support::{NativeError, NativeErrorCode};
use scan_primitives::{Affine, GrayImage, Point};
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageJob {
    input_path: PathBuf,
    #[serde(default)]
    output_path: Option<PathBuf>,
    #[serde(default)]
    metadata_path: Option<PathBuf>,
    #[serde(default)]
    outputs: Vec<PageOutputJob>,
    #[serde(default)]
    source_page_index: Option<usize>,
    #[serde(default)]
    page_metadata_path: Option<PathBuf>,
    #[serde(default)]
    options: Option<CleanupOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageOutputJob {
    output_path: PathBuf,
    metadata_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchManifest {
    #[serde(default)]
    shared_options: CleanupOptions,
    pages: Vec<PageJob>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    event: &'a str,
    page: usize,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_paths: Option<&'a [PathBuf]>,
}

struct WrittenOutput {
    output_path: PathBuf,
    metadata_path: PathBuf,
    options: CleanupOptions,
    is_color: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageResultMetadata {
    source_page_index: usize,
    layout_classification: crate::split::LayoutClassification,
    cutter_x: Option<f64>,
    rotation: OrthogonalRotation,
    excluded: bool,
    blank_outputs_skipped: usize,
    output_count: usize,
}

struct PageRunResult {
    outputs: Vec<WrittenOutput>,
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = args.into_iter().collect();
    if args.len() == 1 && args[0] == "--protocol-version" {
        println!("{PROTOCOL_VERSION}");
        return Ok(());
    }
    if args.len() == 1 && args[0] == "--version" {
        println!("evb-scan-cleanup {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if let Some(index) = args.iter().position(|argument| argument == "--manifest") {
        let path = args
            .get(index + 1)
            .ok_or_else(|| invalid("--manifest requires a JSON path"))?;
        return run_manifest(Path::new(path));
    }
    let input = required_path(&args, "--input")?;
    let output = required_path(&args, "--output")?;
    let metadata = required_path(&args, "--metadata")?;
    let mut options = optional_value(&args, "--options")
        .map(parse_options)
        .transpose()?
        .unwrap_or_default();
    if args.iter().any(|argument| argument == "--ocr-mode") {
        options.ocr_mode = true;
    }
    if args
        .iter()
        .any(|argument| argument == "--experimental-auto-dewarp")
    {
        options.experimental_auto_dewarp = true;
    }
    run_page(
        &PageJob {
            input_path: input,
            output_path: Some(output),
            metadata_path: Some(metadata),
            outputs: Vec::new(),
            source_page_index: Some(0),
            page_metadata_path: None,
            options: Some(options),
        },
        None,
        0,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path) -> Result<(), Box<dyn Error>> {
    let manifest: BatchManifest = serde_json::from_slice(&fs::read(path)?)
        .map_err(|error| invalid(format!("Invalid batch manifest: {error}")))?;
    if manifest.pages.is_empty() {
        return Err(invalid("Batch manifest contains no pages").into());
    }
    println!(
        "{}",
        serde_json::to_string(&Progress {
            event: "start",
            page: 0,
            total: manifest.pages.len(),
            output_paths: None
        })?
    );
    let mut written_outputs = Vec::new();
    for (index, page) in manifest.pages.iter().enumerate() {
        let page_result = run_page(page, Some(&manifest.shared_options), index)?;
        let output_paths = page_result
            .outputs
            .iter()
            .map(|output| output.output_path.clone())
            .collect::<Vec<_>>();
        written_outputs.extend(page_result.outputs);
        println!(
            "{}",
            serde_json::to_string(&Progress {
                event: "page-complete",
                page: index + 1,
                total: manifest.pages.len(),
                output_paths: Some(&output_paths)
            })?
        );
    }
    match_page_sizes(&written_outputs)?;
    println!(
        "{}",
        serde_json::to_string(&Progress {
            event: "complete",
            page: manifest.pages.len(),
            total: manifest.pages.len(),
            output_paths: None
        })?
    );
    Ok(())
}

fn run_page(
    job: &PageJob,
    shared: Option<&CleanupOptions>,
    fallback_page_index: usize,
) -> Result<PageRunResult, Box<dyn Error>> {
    let options = job.options.as_ref().or(shared).cloned().unwrap_or_default();
    options.validate().map_err(invalid)?;
    let color_input = if options.output_mode == OutputMode::Color {
        Some(
            png::read_image(&job.input_path, options.max_pixels, options.max_dimension)
                .map_err(map_image_error)?,
        )
    } else {
        None
    };
    let gray_input = if color_input.is_none() {
        Some(
            png::read_gray(&job.input_path, options.max_pixels, options.max_dimension)
                .map_err(map_image_error)?,
        )
    } else {
        None
    };
    let input_gray = color_input
        .as_ref()
        .map(|input| &input.gray)
        .or(gray_input.as_ref())
        .expect("cleanup input is initialized");
    let result = clean_page_with_color(
        input_gray,
        color_input.as_ref().map(|input| &input.rgb),
        &options,
        job.source_page_index.unwrap_or(fallback_page_index),
    )
    .map_err(invalid)?;
    if options.ocr_mode
        && (result.outputs.len() != 1
            || result.outputs[0].image.width() != input_gray.width()
            || result.outputs[0].image.height() != input_gray.height())
    {
        return Err(invalid("OCR mode changed output dimensions").into());
    }
    let page_metadata = PageResultMetadata {
        source_page_index: job.source_page_index.unwrap_or(fallback_page_index),
        layout_classification: result.classification,
        cutter_x: result.cutter_x,
        rotation: result.rotation,
        excluded: result.excluded,
        blank_outputs_skipped: result.blank_outputs_skipped,
        output_count: result.outputs.len(),
    };
    let destinations = resolve_destinations(job, result.outputs.len())?;
    let mut written = Vec::with_capacity(result.outputs.len());
    for (output, destination) in result.outputs.iter().zip(&destinations) {
        if let Some(color) = &output.color_image {
            png::write_rgb_atomic(&destination.output_path, color)
                .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
        } else {
            png::write_gray_atomic(&destination.output_path, &output.image)
                .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
        }
        write_json_atomic(&destination.metadata_path, &output.metadata)?;
        written.push(WrittenOutput {
            output_path: destination.output_path.clone(),
            metadata_path: destination.metadata_path.clone(),
            options: options.clone(),
            is_color: output.color_image.is_some(),
        });
    }
    if let Some(path) = &job.page_metadata_path {
        write_json_atomic(path, &page_metadata)?;
    }
    Ok(PageRunResult { outputs: written })
}

fn match_page_sizes(outputs: &[WrittenOutput]) -> Result<(), Box<dyn Error>> {
    let eligible = outputs
        .iter()
        .filter(|output| output.options.match_page_size && !output.options.ocr_mode)
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Ok(());
    }

    let mut target_width = 0usize;
    let mut target_height = 0usize;
    for output in &eligible {
        let image = png::read_gray(
            &output.output_path,
            output.options.max_pixels,
            output.options.max_dimension,
        )
        .map_err(map_image_error)?;
        target_width = target_width.max(image.width());
        target_height = target_height.max(image.height());
    }
    validate_uniform_canvas(target_width, target_height, &eligible)?;

    for output in eligible {
        let image = png::read_gray(
            &output.output_path,
            output.options.max_pixels,
            output.options.max_dimension,
        )
        .map_err(map_image_error)?;
        let available_width = target_width.saturating_sub(image.width());
        let available_height = target_height.saturating_sub(image.height());
        let (left, top) = output
            .options
            .page_alignment
            .offset(available_width, available_height);
        let right = available_width - left;
        let bottom = available_height - top;
        let mut metadata: CleanupMetadata =
            serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
        metadata.soft_margins_pixels = [left, top, right, bottom];
        metadata.uniform_canvas = true;
        metadata.output_width = target_width;
        metadata.output_height = target_height;
        translate_metadata(&mut metadata, left, top, target_width, target_height);

        if available_width != 0 || available_height != 0 {
            if output.is_color {
                let image = png::read_image(
                    &output.output_path,
                    output.options.max_pixels,
                    output.options.max_dimension,
                )?
                .rgb;
                let canvas =
                    place_rgb_on_white_canvas(&image, target_width, target_height, left, top);
                png::write_rgb_atomic(&output.output_path, &canvas)
                    .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
            } else {
                let canvas = place_on_white_canvas(&image, target_width, target_height, left, top);
                png::write_gray_atomic(&output.output_path, &canvas)
                    .map_err(|message| NativeError::new(NativeErrorCode::Io, message))?;
            }
        }
        write_json_atomic(&output.metadata_path, &metadata)?;
    }
    Ok(())
}

fn validate_uniform_canvas(
    width: usize,
    height: usize,
    outputs: &[&WrittenOutput],
) -> Result<(), NativeError> {
    let pixels = (width as u64).saturating_mul(height as u64);
    for output in outputs {
        if width > output.options.max_dimension as usize
            || height > output.options.max_dimension as usize
            || pixels > output.options.max_pixels
        {
            return Err(NativeError::new(
                NativeErrorCode::TooLarge,
                format!("Uniform page canvas {width}x{height} exceeds cleanup guardrails"),
            ));
        }
    }
    Ok(())
}

fn place_on_white_canvas(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> GrayImage {
    let mut canvas = GrayImage::new(width, height, 255);
    for y in 0..source.height() {
        for x in 0..source.width() {
            canvas.set(left + x, top + y, source.get(x, y));
        }
    }
    canvas
}

fn place_rgb_on_white_canvas(
    source: &RgbImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> RgbImage {
    let mut canvas = RgbImage::new(width, height, [255; 3]);
    for y in 0..source.height() {
        for x in 0..source.width() {
            canvas.set(left + x, top + y, source.get(x, y));
        }
    }
    canvas
}

fn translate_metadata(
    metadata: &mut CleanupMetadata,
    left: usize,
    top: usize,
    target_width: usize,
    target_height: usize,
) {
    let translation = Affine::translation(left as f64, top as f64);
    if let Some(forward) = metadata.forward_transform {
        let translated = forward.then(translation);
        metadata.forward_transform = Some(translated);
        metadata.inverse_transform = translated.inverse();
    }
    if let Some(mapping) = &mut metadata.dewarp_mapping {
        mapping.output_origin = Point::new(left as f64, top as f64);
        mapping.output_width = target_width;
        mapping.output_height = target_height;
        for point in &mut mapping.source_to_output {
            point.x += left as f64;
            point.y += top as f64;
        }
    }
}

fn resolve_destinations(
    job: &PageJob,
    output_count: usize,
) -> Result<Vec<PageOutputJob>, NativeError> {
    if !job.outputs.is_empty() {
        if job.outputs.len() < output_count {
            return Err(invalid(format!(
                "Cleanup produced {output_count} pages but only {} output destinations were supplied",
                job.outputs.len()
            )));
        }
        return Ok(job
            .outputs
            .iter()
            .take(output_count)
            .map(|output| PageOutputJob {
                output_path: output.output_path.clone(),
                metadata_path: output.metadata_path.clone(),
            })
            .collect());
    }
    let output = job
        .output_path
        .as_ref()
        .ok_or_else(|| invalid("Page job requires outputPath or outputs"))?;
    let metadata = job
        .metadata_path
        .as_ref()
        .ok_or_else(|| invalid("Page job requires metadataPath or outputs"))?;
    if output_count == 1 {
        return Ok(vec![PageOutputJob {
            output_path: output.clone(),
            metadata_path: metadata.clone(),
        }]);
    }
    Ok((0..output_count)
        .map(|index| PageOutputJob {
            output_path: suffixed_path(output, index),
            metadata_path: suffixed_path(metadata, index),
        })
        .collect())
}

fn suffixed_path(path: &Path, index: usize) -> PathBuf {
    let suffix = if index == 0 { "left" } else { "right" };
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("page");
    let extension = path.extension().and_then(|value| value.to_str());
    let name = match extension {
        Some(extension) => format!("{stem}-{suffix}.{extension}"),
        None => format!("{stem}-{suffix}"),
    };
    path.with_file_name(name)
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    let result = (|| {
        fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
        fs::rename(&temporary, path)?;
        Ok::<_, Box<dyn Error>>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn required_path(args: &[String], name: &str) -> Result<PathBuf, NativeError> {
    optional_value(args, name)
        .map(PathBuf::from)
        .ok_or_else(|| invalid(format!("Missing required argument {name}")))
}
fn optional_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|argument| argument == name)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}
fn parse_options(value: &str) -> Result<CleanupOptions, NativeError> {
    let json = if value.trim_start().starts_with('{') {
        value.as_bytes().to_vec()
    } else {
        fs::read(value).map_err(|error| invalid(format!("Unable to read options: {error}")))?
    };
    serde_json::from_slice(&json)
        .map_err(|error| invalid(format!("Invalid cleanup options: {error}")))
}
fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}
fn map_image_error(message: String) -> NativeError {
    let code = if message.contains("guardrails") {
        NativeErrorCode::TooLarge
    } else {
        NativeErrorCode::InvalidRequest
    };
    NativeError::new(code, message)
}
