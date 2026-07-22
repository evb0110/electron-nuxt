use crate::adapters::single_ocr_cli::{invalid, optional_value, parse_options, required_path};
use crate::{
    pipeline::{
        analyze_page_with_document_prior, clean_page_with_color, AnalysisOutputMetadata,
        CleanupMetadata, MatchedCanvasPolicy,
    },
    png::{self, RgbImage},
    protocol::{
        manifest_v2::{CanvasScope, ManifestV2, Operation, RenderMode},
        progress::{Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
    CleanupOptions, OrthogonalRotation, OutputMode, PROTOCOL_VERSION,
};
use evb_native_support::{NativeError, NativeErrorCode, NativeErrorEnvelope};
use rayon::prelude::*;
use scan_primitives::GrayImage;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    #[serde(default)]
    classify_only: Option<bool>,
    #[serde(default)]
    document_prior: Option<crate::split::DocumentPrior>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageOutputJob {
    output_path: PathBuf,
    metadata_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchManifest {
    #[serde(default)]
    shared_options: CleanupOptions,
    #[serde(default)]
    classify_only: bool,
    #[serde(default)]
    preview_mode: bool,
    #[serde(skip)]
    canvas_scope: CanvasScope,
    pages: Vec<PageJob>,
}

impl From<ManifestV2> for BatchManifest {
    fn from(manifest: ManifestV2) -> Self {
        let classify_only = manifest.operation == Operation::Analyze;
        Self {
            shared_options: CleanupOptions::default(),
            classify_only,
            preview_mode: manifest.render_mode == RenderMode::Preview,
            canvas_scope: manifest.canvas_scope,
            pages: manifest
                .pages
                .into_iter()
                .map(|page| PageJob {
                    input_path: page.input_path,
                    output_path: None,
                    metadata_path: None,
                    outputs: page
                        .outputs
                        .into_iter()
                        .map(|output| PageOutputJob {
                            output_path: output.output_path,
                            metadata_path: output.metadata_path,
                        })
                        .collect(),
                    source_page_index: Some(page.source_page_index),
                    page_metadata_path: Some(page.page_metadata_path),
                    options: Some(page.options),
                    classify_only: Some(classify_only),
                    document_prior: page.document_prior,
                })
                .collect(),
        }
    }
}

struct WrittenOutput {
    output_path: PathBuf,
    metadata_path: PathBuf,
    options: CleanupOptions,
    is_color: bool,
    half: crate::pipeline::PageHalf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageResultMetadata {
    source_page_index: usize,
    layout_classification: crate::split::LayoutClassification,
    layout_confidence: f64,
    cutter_x_px: Option<f64>,
    rotation_degrees: OrthogonalRotation,
    canvas_scope: CanvasScope,
    excluded: bool,
    blank_outputs_skipped: usize,
    output_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    outputs: Vec<AnalysisOutputMetadata>,
    tier1_verdict: crate::split::LayoutClassification,
    reconciled: bool,
    cluster_agreement: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_prior: Option<crate::split::DocumentPrior>,
    #[serde(skip)]
    rotated_width: usize,
    #[serde(skip)]
    rotated_height: usize,
    #[serde(skip)]
    candidate_cutter_ratio: Option<f64>,
    #[serde(skip)]
    whitespace_score: f64,
    #[serde(skip)]
    reconciliation_eligible: bool,
    #[serde(skip)]
    tier1_confidence: f64,
}

struct PageRunResult {
    outputs: Vec<WrittenOutput>,
    metadata: PageResultMetadata,
    page_metadata_path: Option<PathBuf>,
    classification_only: bool,
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
        let allow_v1 = args
            .iter()
            .any(|argument| argument == "--allow-manifest-v1");
        return run_manifest(Path::new(path), allow_v1);
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
        options.experimental.auto_dewarp = true;
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
            classify_only: None,
            document_prior: None,
        },
        None,
        0,
        CanvasScope::Page,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path, allow_v1: bool) -> Result<(), Box<dyn Error>> {
    let bytes = fs::read(path)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| invalid(format!("Invalid batch manifest: {error}")))?;
    let manifest = match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(2) => {
            let manifest: ManifestV2 = serde_json::from_value(value)
                .map_err(|error| invalid(format!("Invalid v2 batch manifest: {error}")))?;
            manifest.validate()?;
            BatchManifest::from(manifest)
        }
        None if allow_v1 => {
            eprintln!("DEPRECATED: accepting scan-cleanup manifest v1 because --allow-manifest-v1 was supplied; migrate to manifest v2");
            let mut value = value;
            normalize_manifest_v1(&mut value);
            let mut manifest: BatchManifest = serde_json::from_value(value)
                .map_err(|error| invalid(format!("Invalid v1 batch manifest: {error}")))?;
            manifest.canvas_scope = if manifest.preview_mode {
                CanvasScope::Page
            } else {
                CanvasScope::Document
            };
            manifest
        }
        None => return Err(invalid("Manifest v1 requires --allow-manifest-v1").into()),
        Some(version) => {
            return Err(invalid(format!(
                "Unsupported scan-cleanup manifest version {version}"
            ))
            .into())
        }
    };
    if manifest.pages.is_empty() {
        return Err(invalid("Batch manifest contains no pages").into());
    }
    let total = manifest.pages.len();
    let result = run_manifest_inner(&manifest);
    match result {
        Ok(()) => {
            println!(
                "{}",
                serde_json::to_string(&ResultEnvelope::success(total, total))?
            );
            Ok(())
        }
        Err(error) => {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            println!(
                "{}",
                serde_json::to_string(&ResultEnvelope::failure(&envelope))?
            );
            Err(error)
        }
    }
}

fn normalize_manifest_v1(value: &mut serde_json::Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };
    if let Some(options) = root.get_mut("sharedOptions") {
        normalize_options_v1(options);
    }
    let Some(pages) = root
        .get_mut("pages")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for page in pages {
        let Some(page) = page.as_object_mut() else {
            continue;
        };
        if let Some(mut options) = page.remove("options") {
            if page.get("classifyOnly").is_none() {
                if let Some(classify_only) = options
                    .as_object_mut()
                    .and_then(|options| options.remove("classifyOnly"))
                {
                    page.insert("classifyOnly".into(), classify_only);
                }
            }
            normalize_options_v1(&mut options);
            page.insert("options".into(), options);
        }
    }
}

fn normalize_options_v1(value: &mut serde_json::Value) {
    let Some(options) = value.as_object_mut() else {
        return;
    };
    for (old, new) in [
        ("rotation", "rotationDegrees"),
        ("maxDimension", "maxDimensionPx"),
    ] {
        if options.get(new).is_none() {
            if let Some(value) = options.remove(old) {
                options.insert(new.into(), value);
            }
        }
    }
    if options.get("experimental").is_none() {
        if let Some(auto_dewarp) = options.remove("experimentalAutoDewarp") {
            options.insert(
                "experimental".into(),
                serde_json::json!({"autoDewarp": auto_dewarp}),
            );
        }
    }
    if options.get("manualSplit").is_none() {
        if let Some(split) = options.remove("manualSplitX") {
            let rotation = options
                .get("rotationDegrees")
                .cloned()
                .unwrap_or_else(|| serde_json::json!(0));
            options.insert(
                "manualSplit".into(),
                serde_json::json!({
                    "xNormalized": split,
                    "rotationDegrees": rotation,
                }),
            );
        }
    }
    if options.get("margins").is_none() {
        let margins = options.remove("marginsMm").or_else(|| {
            let pixels = options.remove("marginsPixels")?;
            let dpi = options
                .get("dpi")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(300.0);
            Some(serde_json::Value::Array(
                pixels
                    .as_array()?
                    .iter()
                    .map(|pixel| serde_json::json!(pixel.as_f64().unwrap_or(0.0) * 25.4 / dpi))
                    .collect(),
            ))
        });
        if let Some(margins) = margins.and_then(|value| value.as_array().cloned()) {
            if margins.len() == 4 {
                options.insert(
                    "margins".into(),
                    serde_json::json!({
                        "leftMm": margins[0],
                        "topMm": margins[1],
                        "rightMm": margins[2],
                        "bottomMm": margins[3],
                    }),
                );
            }
        }
    }
}

fn run_manifest_inner(manifest: &BatchManifest) -> Result<(), Box<dyn Error>> {
    write_progress(Progress {
        stage: ProgressStage::Started,
        completed_pages: 0,
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
    })?;
    let run_one = |(index, page): (usize, &PageJob)| {
        run_manifest_page(manifest, page, index).map_err(|error| {
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            NativeError::new(envelope.code, envelope.message)
        })
    };
    let page_results = if manifest.pages.len() > 1 && pages_have_disjoint_destinations(manifest) {
        rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|index| format!("scan-cleanup-page-{index}"))
            .build()
            .map_err(|error| invalid(format!("Unable to initialize page workers: {error}")))?
            .install(|| {
                manifest
                    .pages
                    .par_iter()
                    .enumerate()
                    .map(run_one)
                    .collect::<Vec<_>>()
            })
    } else {
        manifest.pages.iter().enumerate().map(run_one).collect()
    };

    let mut page_results = page_results.into_iter().collect::<Result<Vec<_>, _>>()?;
    reconcile_classification_batch(&mut page_results);
    let mut written_outputs = Vec::new();
    for (index, page_result) in page_results.into_iter().enumerate() {
        if let Some(path) = &page_result.page_metadata_path {
            write_json_atomic(path, &page_result.metadata)?;
        }
        let output_paths = page_result
            .outputs
            .iter()
            .map(|output| output.output_path.clone())
            .collect::<Vec<_>>();
        written_outputs.extend(page_result.outputs);
        write_progress(Progress {
            stage: ProgressStage::PageComplete,
            completed_pages: index + 1,
            total_pages: manifest.pages.len(),
            page_number: Some(index + 1),
            output_paths: Some(output_paths),
            classification: Some(page_result.metadata.layout_classification),
            confidence: Some(page_result.metadata.layout_confidence),
            cutter_x_px: (page_result.metadata.layout_classification
                == crate::split::LayoutClassification::TwoPageSpread)
                .then_some(page_result.metadata.cutter_x_px)
                .flatten(),
            tier1_verdict: Some(page_result.metadata.tier1_verdict),
            reconciled: Some(page_result.metadata.reconciled),
            cluster_agreement: Some(page_result.metadata.cluster_agreement),
            document_prior: page_result.metadata.document_prior,
        })?;
    }
    match_page_sizes(&written_outputs, manifest.preview_mode)?;
    write_progress(Progress {
        stage: ProgressStage::Completed,
        completed_pages: manifest.pages.len(),
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
    })?;
    Ok(())
}

fn reconcile_classification_batch(results: &mut [PageRunResult]) {
    let eligible = results
        .iter()
        .enumerate()
        .filter(|(_, result)| {
            result.classification_only
                && result.metadata.reconciliation_eligible
                && result.metadata.document_prior.is_none()
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for index in eligible {
        let metadata = &results[index].metadata;
        if let Some(cluster) = clusters.iter_mut().find(|cluster| {
            let representative = &results[cluster[0]].metadata;
            dimensions_within_tolerance(metadata.rotated_width, representative.rotated_width)
                && dimensions_within_tolerance(
                    metadata.rotated_height,
                    representative.rotated_height,
                )
        }) {
            cluster.push(index);
        } else {
            clusters.push(vec![index]);
        }
    }

    for cluster in clusters {
        let confident = cluster
            .iter()
            .copied()
            .filter(|&index| results[index].metadata.tier1_confidence >= 0.60)
            .collect::<Vec<_>>();
        let mut support = [0usize; 3];
        let mut confidence_sum = [0.0; 3];
        for &index in &confident {
            let metadata = &results[index].metadata;
            let bucket = classification_bucket(metadata.tier1_verdict);
            support[bucket] += 1;
            confidence_sum[bucket] += metadata.tier1_confidence;
        }
        let Some(dominant_bucket) = (0..support.len())
            .filter(|&bucket| support[bucket] >= 2)
            .max_by(|&left, &right| {
                support[left]
                    .cmp(&support[right])
                    .then_with(|| confidence_sum[left].total_cmp(&confidence_sum[right]))
            })
        else {
            continue;
        };
        let tied = (0..support.len()).any(|bucket| {
            bucket != dominant_bucket
                && support[bucket] == support[dominant_bucket]
                && (confidence_sum[bucket] - confidence_sum[dominant_bucket]).abs() < 1e-9
        });
        if tied {
            continue;
        }
        let dominant_layout = bucket_classification(dominant_bucket);
        let dominant_count = support[dominant_bucket];
        let consensus = dominant_count as f64 / confident.len().max(1) as f64;
        let mean_confidence = confidence_sum[dominant_bucket] / dominant_count as f64;
        let mut cutter_ratios = confident
            .iter()
            .filter_map(|&index| {
                let metadata = &results[index].metadata;
                (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                    .then_some(metadata.cutter_x_px)
                    .flatten()
                    .map(|cutter| cutter / metadata.rotated_width.max(1) as f64)
            })
            .collect::<Vec<_>>();
        cutter_ratios.sort_by(f64::total_cmp);
        let cutter_ratio_median = (dominant_layout == LayoutClassification::TwoPageSpread)
            .then(|| median(&cutter_ratios))
            .flatten();
        if dominant_layout == LayoutClassification::TwoPageSpread && cutter_ratio_median.is_none() {
            continue;
        }
        let cutter_spread = cutter_ratios
            .first()
            .zip(cutter_ratios.last())
            .map_or(0.0, |(first, last)| last - first);
        let cutter_consistency = 1.0 - ramp_local(cutter_spread, 0.03, 0.12) * 0.40;
        let agreement_strength =
            (consensus * (0.65 + 0.25 * mean_confidence) * cutter_consistency).clamp(0.0, 0.95);
        let mut widths = cluster
            .iter()
            .map(|&index| results[index].metadata.rotated_width as f64)
            .collect::<Vec<_>>();
        let mut heights = cluster
            .iter()
            .map(|&index| results[index].metadata.rotated_height as f64)
            .collect::<Vec<_>>();
        widths.sort_by(f64::total_cmp);
        heights.sort_by(f64::total_cmp);
        let prior = crate::split::DocumentPrior {
            dominant_layout,
            cutter_ratio_median,
            cluster_dims: crate::split::ClusterDimensions {
                width: median(&widths).unwrap_or(1.0),
                height: median(&heights).unwrap_or(1.0),
            },
            agreement_strength,
        };

        for index in cluster {
            let metadata = &mut results[index].metadata;
            let tier1_cutter = (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                .then_some(metadata.cutter_x_px)
                .flatten();
            let decision = crate::split::reconcile_layout_decision(
                metadata.tier1_verdict,
                metadata.tier1_confidence,
                tier1_cutter,
                metadata.candidate_cutter_ratio,
                metadata.whitespace_score,
                metadata.rotated_width,
                metadata.rotated_height,
                prior,
            );
            metadata.layout_classification = decision.classification;
            metadata.layout_confidence = decision.confidence;
            metadata.cutter_x_px = decision.cutter_x;
            metadata.tier1_verdict = decision.reconciliation.tier1_verdict;
            metadata.reconciled = decision.reconciliation.reconciled;
            metadata.cluster_agreement = decision.reconciliation.cluster_agreement;
            metadata.document_prior = Some(prior);
            metadata.output_count = if metadata.excluded {
                0
            } else if decision.classification == LayoutClassification::TwoPageSpread {
                2
            } else {
                1
            };
            if decision.reconciliation.reconciled {
                metadata.outputs.clear();
            }
        }
    }
}

fn dimensions_within_tolerance(left: usize, right: usize) -> bool {
    left.abs_diff(right) as f64 / left.max(right).max(1) as f64 <= 0.02
}

fn classification_bucket(classification: LayoutClassification) -> usize {
    match classification {
        LayoutClassification::SingleUncutPage => 0,
        LayoutClassification::PageWithOffcut => 1,
        LayoutClassification::TwoPageSpread => 2,
    }
}

fn bucket_classification(bucket: usize) -> LayoutClassification {
    match bucket {
        0 => LayoutClassification::SingleUncutPage,
        1 => LayoutClassification::PageWithOffcut,
        _ => LayoutClassification::TwoPageSpread,
    }
}

fn median(values: &[f64]) -> Option<f64> {
    match values.len() {
        0 => None,
        length if length % 2 == 1 => Some(values[length / 2]),
        length => Some((values[length / 2 - 1] + values[length / 2]) * 0.5),
    }
}

fn ramp_local(value: f64, low: f64, high: f64) -> f64 {
    ((value - low) / (high - low)).clamp(0.0, 1.0)
}

fn write_progress(progress: Progress) -> Result<(), Box<dyn Error>> {
    println!(
        "{}",
        serde_json::to_string(&ProgressEnvelope::new(progress))?
    );
    Ok(())
}

fn run_manifest_page(
    manifest: &BatchManifest,
    page: &PageJob,
    index: usize,
) -> Result<PageRunResult, Box<dyn Error>> {
    let classify_only = page.classify_only.unwrap_or_else(|| {
        page.options
            .as_ref()
            .and_then(|options| options.classify_only)
            .or(manifest.shared_options.classify_only)
            .unwrap_or(manifest.classify_only)
    });
    if classify_only {
        run_classification(
            page,
            Some(&manifest.shared_options),
            index,
            manifest.canvas_scope,
        )
    } else {
        run_page(
            page,
            Some(&manifest.shared_options),
            index,
            manifest.canvas_scope,
        )
    }
}

fn pages_have_disjoint_destinations(manifest: &BatchManifest) -> bool {
    let mut paths = HashSet::new();
    manifest.pages.iter().all(|page| {
        let page_paths = page
            .output_path
            .iter()
            .chain(&page.metadata_path)
            .chain(&page.page_metadata_path)
            .chain(
                page.outputs
                    .iter()
                    .flat_map(|output| [&output.output_path, &output.metadata_path]),
            );
        page_paths
            .into_iter()
            .all(|path| paths.insert(path.clone()))
    })
}

fn run_page(
    job: &PageJob,
    shared: Option<&CleanupOptions>,
    fallback_page_index: usize,
    canvas_scope: CanvasScope,
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
    let mut result = clean_page_with_color(
        input_gray,
        color_input.as_ref().map(|input| &input.rgb),
        &options,
        job.source_page_index.unwrap_or(fallback_page_index),
    )
    .map_err(invalid)?;
    for output in &mut result.outputs {
        output.metadata.canvas_scope = canvas_scope;
    }
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
        layout_confidence: result.layout_confidence,
        cutter_x_px: result.cutter_x,
        rotation_degrees: result.rotation,
        canvas_scope,
        excluded: result.excluded,
        blank_outputs_skipped: result.blank_outputs_skipped,
        output_count: result.outputs.len(),
        outputs: Vec::new(),
        tier1_verdict: result.classification,
        reconciled: false,
        cluster_agreement: 0.0,
        document_prior: None,
        rotated_width: if matches!(
            options.rotation,
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
        ) {
            input_gray.height()
        } else {
            input_gray.width()
        },
        rotated_height: if matches!(
            options.rotation,
            OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
        ) {
            input_gray.width()
        } else {
            input_gray.height()
        },
        candidate_cutter_ratio: result
            .cutter_x
            .map(|cutter| cutter / input_gray.width().max(1) as f64),
        whitespace_score: 0.0,
        reconciliation_eligible: false,
        tier1_confidence: result.layout_confidence,
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
            half: output.metadata.half,
        });
    }
    Ok(PageRunResult {
        outputs: written,
        metadata: page_metadata,
        page_metadata_path: job.page_metadata_path.clone(),
        classification_only: false,
    })
}

fn run_classification(
    job: &PageJob,
    shared: Option<&CleanupOptions>,
    fallback_page_index: usize,
    canvas_scope: CanvasScope,
) -> Result<PageRunResult, Box<dyn Error>> {
    let options = job.options.as_ref().or(shared).cloned().unwrap_or_default();
    options.validate().map_err(invalid)?;
    let input = png::read_gray(&job.input_path, options.max_pixels, options.max_dimension)
        .map_err(map_image_error)?;
    let result =
        analyze_page_with_document_prior(&input, &options, job.document_prior).map_err(invalid)?;
    let page_metadata = PageResultMetadata {
        source_page_index: job.source_page_index.unwrap_or(fallback_page_index),
        layout_classification: result.classification,
        layout_confidence: result.confidence,
        cutter_x_px: result.cutter_x,
        rotation_degrees: result.rotation,
        canvas_scope,
        excluded: result.excluded,
        blank_outputs_skipped: 0,
        output_count: if result.excluded {
            0
        } else if result.classification == crate::split::LayoutClassification::TwoPageSpread {
            2
        } else {
            1
        },
        outputs: result.outputs,
        tier1_verdict: result.reconciliation.tier1_verdict,
        reconciled: result.reconciliation.reconciled,
        cluster_agreement: result.reconciliation.cluster_agreement,
        document_prior: job.document_prior,
        rotated_width: result.rotated_width,
        rotated_height: result.rotated_height,
        candidate_cutter_ratio: result.candidate_cutter_ratio,
        whitespace_score: result.whitespace_score,
        reconciliation_eligible: matches!(options.layout, crate::LayoutMode::Auto)
            && options.manual_split_x.is_none()
            && !options.excluded,
        tier1_confidence: if result.reconciliation.reconciled
            || result.reconciliation.cluster_agreement != 0.0
        {
            0.0
        } else {
            result.confidence
        },
    };
    let metadata_path = job
        .page_metadata_path
        .as_ref()
        .or_else(|| job.outputs.first().map(|output| &output.metadata_path))
        .or(job.metadata_path.as_ref())
        .ok_or_else(|| {
            invalid(
                "Classify-only page job requires pageMetadataPath, metadataPath, or a declared output metadataPath",
            )
        })?;
    Ok(PageRunResult {
        outputs: Vec::new(),
        metadata: page_metadata,
        page_metadata_path: Some(metadata_path.clone()),
        classification_only: true,
    })
}

fn match_page_sizes(outputs: &[WrittenOutput], preview_mode: bool) -> Result<(), Box<dyn Error>> {
    let eligible = outputs
        .iter()
        .filter(|output| output.options.match_page_size && !output.options.ocr_mode)
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Ok(());
    }

    let images = eligible
        .iter()
        .map(|output| {
            png::read_gray(
                &output.output_path,
                output.options.max_pixels,
                output.options.max_dimension,
            )
            .map_err(map_image_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let target_width = robust_quantile_dimension(images.iter().map(GrayImage::width));
    let target_height = robust_quantile_dimension(images.iter().map(GrayImage::height));
    validate_uniform_canvas(target_width, target_height, &eligible)?;

    for (output, image) in eligible.into_iter().zip(images) {
        let overflow = image.width() > target_width || image.height() > target_height;
        let available_width = if overflow {
            0
        } else {
            target_width - image.width()
        };
        let available_height = if overflow {
            0
        } else {
            target_height - image.height()
        };
        let (left, top) = output
            .options
            .placement_for(output.half)
            .offset(available_width, available_height);
        let right = available_width - left;
        let bottom = available_height - top;
        let mut metadata: CleanupMetadata =
            serde_json::from_slice(&fs::read(&output.metadata_path)?)?;
        metadata.soft_margins_pixels = [left, top, right, bottom];
        metadata.uniform_canvas = !overflow;
        metadata.canvas_policy = if overflow {
            MatchedCanvasPolicy::OverflowIntrinsic
        } else {
            MatchedCanvasPolicy::RobustQuantile
        };
        metadata.canvas_overflow = overflow;
        metadata.matched_canvas_target_width = Some(target_width);
        metadata.matched_canvas_target_height = Some(target_height);
        metadata.canvas_width = if overflow {
            image.width()
        } else {
            target_width
        };
        metadata.canvas_height = if overflow {
            image.height()
        } else {
            target_height
        };
        metadata.placement_offset_x = left;
        metadata.placement_offset_y = top;
        if overflow {
            metadata.warnings.push(format!(
                "Matched canvas target {target_width}x{target_height} would clip intrinsic page {}x{}; retained intrinsic size",
                image.width(),
                image.height()
            ));
        }

        if !overflow && !preview_mode && (available_width != 0 || available_height != 0) {
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

fn robust_quantile_dimension(values: impl Iterator<Item = usize>) -> usize {
    let mut values = values.collect::<Vec<_>>();
    values.sort_unstable();
    let rank = values.len().saturating_mul(9).div_ceil(10).max(1);
    values[rank - 1]
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
fn map_image_error(message: String) -> NativeError {
    let code = if message.contains("guardrails") {
        NativeErrorCode::TooLarge
    } else {
        NativeErrorCode::InvalidRequest
    };
    NativeError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::robust_quantile_dimension;

    #[test]
    fn matched_canvas_dimension_uses_nearest_rank_ninetieth_percentile() {
        assert_eq!(robust_quantile_dimension([60, 60].into_iter()), 60);
        assert_eq!(
            robust_quantile_dimension([80, 80, 80, 80, 80, 80, 80, 80, 80, 140].into_iter()),
            80
        );
    }
}
