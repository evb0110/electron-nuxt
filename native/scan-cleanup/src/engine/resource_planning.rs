//! Memory and worker planning for batch page processing.
use crate::cache::{ByteLru, PageCache, SourceFingerprint, DEFAULT_CACHE_BUDGET_BYTES};
use crate::domain::options::OutputMode;
use crate::engine::staged_input::{invalid, map_raster_error};
use crate::io::raster;
use evb_native_support::NativeError;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlanningOperation {
    Analyze,
    Render,
}

#[derive(Clone, Debug)]
pub(crate) struct PageDescriptor {
    pub(crate) input_path: PathBuf,
    pub(crate) source_page_index: usize,
    pub(crate) options: CleanupOptionsView,
    pub(crate) stream_input: bool,
    pub(crate) trusted_foreground_mask_path: Option<PathBuf>,
    pub(crate) trusted_mrc_background_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupOptionsView {
    pub(crate) max_pixels: u64,
    pub(crate) max_dimension: u32,
    pub(crate) output_mode: OutputMode,
    pub(crate) source_has_bilevel_layer: bool,
    pub(crate) thickness: i8,
}

pub(crate) trait PlanningManifest {
    fn operation(&self) -> PlanningOperation;
    fn host_memory_bytes(&self) -> Option<u64>;
    fn staged_input_window(&self) -> Option<usize>;
    fn staged_input_peak_pixels(&self) -> Option<u64>;
    fn page_count(&self) -> usize;
    fn page(&self, index: usize) -> PageDescriptor;

    fn run_stream_page_jobs<T, F>(&self, task: F) -> Result<Vec<T>, Box<dyn Error>>
    where
        T: Send,
        F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync;
}

pub(crate) fn manifest_cache(
    operation: PlanningOperation,
    host_memory_bytes: Option<u64>,
) -> Arc<Mutex<ByteLru>> {
    Arc::new(Mutex::new(ByteLru::new(cache_budget_bytes(
        operation,
        host_memory_bytes,
    ))))
}

pub(crate) fn page_cache_for(
    page: &PageDescriptor,
    shared: &Arc<Mutex<ByteLru>>,
) -> Result<PageCache, NativeError> {
    let source = SourceFingerprint::from_path(&page.input_path, page.source_page_index).map_err(
        |error| {
            NativeError::new(
                evb_native_support::NativeErrorCode::Io,
                format!(
                    "Unable to read scan-cleanup input for page {} ({}): {error}",
                    page.source_page_index + 1,
                    page.input_path.display(),
                ),
            )
        },
    )?;
    Ok(PageCache::new(Arc::clone(shared), source))
}
pub(crate) fn run_page_jobs<M, T, F>(manifest: &M, task: F) -> Result<Vec<T>, Box<dyn Error>>
where
    M: PlanningManifest + Sync,
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    if (0..manifest.page_count()).any(|index| manifest.page(index).stream_input) {
        return manifest.run_stream_page_jobs(task);
    }
    let worker_threads = page_worker_threads(manifest)?;
    let processing_threads = std::thread::available_parallelism().map_or(1, usize::from);
    run_regular_page_jobs(manifest, task, worker_threads, processing_threads)
}

pub(crate) fn run_regular_page_jobs<M, T, F>(
    manifest: &M,
    task: F,
    worker_threads: usize,
    processing_threads: usize,
) -> Result<Vec<T>, Box<dyn Error>>
where
    M: PlanningManifest + Sync,
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    let results: Vec<Result<T, NativeError>> = if worker_threads > 1 {
        let pool = rayon::ThreadPoolBuilder::new()
            // `worker_threads` is a memory-derived limit on pages in flight,
            // not the size of the processing pool. Each page contains nested
            // Rayon stages (thresholding, morphology, composition, and
            // resampling) which must retain access to the host's CPU threads.
            // Building a pool with only the page limit made two large pages
            // run every heavy stage on two total threads.
            .num_threads(processing_threads)
            .thread_name(|index| format!("scan-cleanup-processing-{index}"))
            .build()
            .map_err(|error| invalid(format!("Unable to initialize page workers: {error}")))?;
        type PageOutcome<T> = Result<Result<T, NativeError>, Box<dyn std::any::Any + Send>>;
        struct DispatchState<T> {
            next_page: usize,
            failure_observed: bool,
            outcomes: Vec<Option<PageOutcome<T>>>,
        }
        let state = Mutex::new(DispatchState {
            next_page: 0,
            failure_observed: false,
            outcomes: (0..manifest.page_count()).map(|_| None).collect(),
        });

        // The bounded page workers are ordinary scoped OS threads. They wait
        // outside Rayon, while each admitted page enters the processing pool
        // through `install`; even a one-thread pool therefore always has a
        // worker available to execute the page and its nested Rayon stages.
        thread::scope(|scope| {
            for _ in 0..worker_threads.min(manifest.page_count()) {
                let state = &state;
                let pool = &pool;
                let task = &task;
                scope.spawn(move || loop {
                    let index = {
                        let mut state = state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if state.failure_observed || state.next_page >= manifest.page_count() {
                            return;
                        }
                        let index = state.next_page;
                        state.next_page += 1;
                        index
                    };
                    let page = manifest.page(index);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        pool.install(|| task((index, &page)))
                    }));
                    let mut state = state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state.failure_observed |= outcome.as_ref().map_or(true, Result::is_err);
                    state.outcomes[index] = Some(outcome);
                });
            }
        });
        let DispatchState {
            outcomes,
            failure_observed,
            ..
        } = state
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if failure_observed {
            // The cancellation decision is made as soon as any page fails,
            // but retain the old ordered-result contract when multiple active
            // pages fail at different times. Panics are captured only long
            // enough to guarantee every submitted page reports completion;
            // the earliest submitted panic is then resumed.
            for outcome in outcomes.into_iter().flatten() {
                match outcome {
                    Err(panic) => std::panic::resume_unwind(panic),
                    Ok(Err(error)) => return Err(error.into()),
                    Ok(Ok(_)) => {}
                }
            }
            unreachable!("page dispatcher observed a failure without recording it");
        }
        outcomes
            .into_iter()
            .map(|outcome| {
                outcome
                    .expect("page dispatcher completed every submitted page")
                    .expect("successful page dispatcher cannot retain a panic")
            })
            .collect()
    } else {
        (0..manifest.page_count())
            .map(|index| {
                let page = manifest.page(index);
                task((index, &page))
            })
            .collect()
    };
    results
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub(crate) fn page_worker_threads<M: PlanningManifest>(manifest: &M) -> Result<usize, NativeError> {
    if (0..manifest.page_count()).any(|index| manifest.page(index).stream_input) {
        // FIFO readers block an OS thread until their producer opens the
        // matching pipe. Running a page-sized Rayon pool over ordered streams
        // can occupy the whole pool with future readers while the current page
        // needs nested Rayon work to finish: a real circular wait observed as
        // 180-second pdftoppm timeouts near the end of large documents.
        Ok(1)
    } else if manifest.page_count() > 1 {
        let threads = manifest_worker_threads(manifest)?;
        // Never lease more staged inputs than the owning process promised to
        // keep on disk: a wider page pool would demand a wider raster window
        // than the scratch budget admitted.
        Ok(manifest
            .staged_input_window()
            .map_or(threads, |window| threads.min(window.max(1))))
    } else {
        Ok(1)
    }
}
pub(crate) const FALLBACK_SYSTEM_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const GRAY_PEAK_BYTES_PER_PIXEL: u64 = 40;
pub(crate) const COLOR_PEAK_BYTES_PER_PIXEL: u64 = 80;

pub(crate) fn manifest_worker_threads<M: PlanningManifest>(
    manifest: &M,
) -> Result<usize, NativeError> {
    let available = std::thread::available_parallelism().map_or(2, usize::from);
    let staged_inputs = manifest.staged_input_window().is_some();
    let measured_peak_page_bytes = (0..manifest.page_count())
        .map(|index| {
            let page = manifest.page(index);
            let options = &page.options;
            // Do not synchronously open pipes or other streaming inputs while
            // sizing the worker pool. Doing so would prevent completed regular
            // pages from reporting analysis progress until every stream opens.
            if page.stream_input {
                return Ok(0);
            }
            // A staged window renders page rasters on request, so most inputs
            // are legitimately absent here. Those pages are measured by the
            // producer's declared document peak below rather than by opening a
            // file that does not exist yet.
            if staged_inputs && !page.input_path.exists() {
                return Ok(0);
            }
            let (width, height) = raster::read_dimensions(
                &page.input_path,
                options.max_pixels,
                options.max_dimension,
            )
            .map_err(|error| map_raster_error(error, &page.input_path, page.source_page_index))?;
            Ok(estimate_peak_page_bytes(
                width,
                height,
                manifest.operation(),
                options.output_mode,
            ))
        })
        .collect::<Result<Vec<_>, NativeError>>()?
        .into_iter()
        .max()
        .unwrap_or(1);
    let declared_peak_page_bytes = manifest.staged_input_peak_pixels().map_or(0, |pixels| {
        peak_page_bytes_for_pixels(pixels, manifest.operation(), OutputMode::Auto)
    });
    let peak_page_bytes = measured_peak_page_bytes.max(declared_peak_page_bytes);
    let total_memory = manifest
        .host_memory_bytes()
        .unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    let process_budget = total_memory.saturating_mul(40) / 100;
    let worker_budget = process_budget
        .saturating_sub(
            cache_budget_bytes(manifest.operation(), manifest.host_memory_bytes()) as u64,
        );
    Ok(adaptive_thread_count(
        available,
        manifest.page_count(),
        worker_budget,
        peak_page_bytes,
    ))
}

/// Calibrated against the resident high-water mark a page actually reaches,
/// not against a sum of the live buffers `run_page` and `clean_region` name.
/// Counting only the named buffers modelled a gray page at twelve bytes per
/// pixel and missed real peak RSS by ~3.3x, because the high-water mark also
/// carries transient scratch inside the stage pipeline and pages the allocator
/// has freed but not returned to the OS. A worker budget divided by an
/// optimistic figure admits threads the host cannot hold, so the multiplier
/// used for sizing is the measured one.
pub(crate) fn estimate_peak_page_bytes(
    width: usize,
    height: usize,
    operation: PlanningOperation,
    output_mode: OutputMode,
) -> u64 {
    peak_page_bytes_for_pixels(
        (width as u64).saturating_mul(height as u64),
        operation,
        output_mode,
    )
}

pub(crate) fn peak_page_bytes_for_pixels(
    pixels: u64,
    operation: PlanningOperation,
    output_mode: OutputMode,
) -> u64 {
    let decodes_color = operation == PlanningOperation::Analyze
        || matches!(
            output_mode,
            OutputMode::Color | OutputMode::Mixed | OutputMode::Auto
        );
    let multiplier = if decodes_color {
        COLOR_PEAK_BYTES_PER_PIXEL
    } else {
        GRAY_PEAK_BYTES_PER_PIXEL
    };
    pixels.saturating_mul(multiplier)
}

pub(crate) fn adaptive_thread_count(
    available_parallelism: usize,
    page_count: usize,
    memory_budget_bytes: u64,
    peak_page_bytes: u64,
) -> usize {
    if page_count == 0 {
        return 1;
    }
    let cpu_limit = (available_parallelism / 2).max(2).min(page_count.max(1));
    let memory_limit = if peak_page_bytes == 0 {
        page_count
    } else {
        (memory_budget_bytes / peak_page_bytes).max(1) as usize
    };
    cpu_limit.min(memory_limit).min(page_count).max(1)
}

pub(crate) fn cache_budget_bytes(
    operation: PlanningOperation,
    host_memory_bytes: Option<u64>,
) -> usize {
    let total_memory = host_memory_bytes.unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    // Analyze retains decoded sources because reconciliation may replay them.
    // Render retains analysis-stage artifacts but deliberately does not retain
    // decoded page inputs, so reserve half as much cache memory while keeping
    // a non-zero budget for those reusable stages.
    let denominator = match operation {
        PlanningOperation::Analyze => 10,
        PlanningOperation::Render => 20,
    };
    let cap = match operation {
        PlanningOperation::Analyze => DEFAULT_CACHE_BUDGET_BYTES,
        // Stage artifacts remain reusable during a render, but decoded page
        // inputs no longer occupy this shared LRU. Keep half the normal cap
        // available for those artifacts instead of reserving no cache at all.
        PlanningOperation::Render => DEFAULT_CACHE_BUDGET_BYTES / 2,
    };
    cap.min((total_memory / denominator) as usize)
}
#[cfg(test)]
mod tests {
    use super::manifest_cache;
    use super::*;
    use crate::engine::page_statistics::{derive_page_ink_contexts, derive_page_ink_sample};
    use crate::protocol::manifest_v3::{
        AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, PageOutput, RenderMode, VERSION,
    };
    use crate::{CleanupOptions, OutputMode};
    use evb_native_support::{NativeError, NativeErrorCode};
    use scan_primitives::GrayImage;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        thread,
        time::Duration,
    };

    fn planning_page(page: &Page) -> PageDescriptor {
        PageDescriptor {
            input_path: page.input_path.clone(),
            source_page_index: page.source_page_index,
            options: CleanupOptionsView {
                max_pixels: page.options.max_pixels,
                max_dimension: page.options.max_dimension,
                output_mode: page.options.output_mode,
                source_has_bilevel_layer: page.options.source_has_bilevel_layer,
                thickness: page.options.thickness,
            },
            stream_input: fs::metadata(&page.input_path)
                .is_ok_and(|metadata| !metadata.file_type().is_file()),
            trusted_foreground_mask_path: page.trusted_foreground_mask_path.clone(),
            trusted_mrc_background_path: page.trusted_mrc_background_path.clone(),
        }
    }

    #[test]
    fn adaptive_threads_respect_cpu_pages_and_memory() {
        assert_eq!(adaptive_thread_count(16, 20, 10_000, 1_000), 8);
        assert_eq!(adaptive_thread_count(16, 3, 10_000, 1_000), 3);
        assert_eq!(adaptive_thread_count(2, 20, 10_000, 1_000), 2);
        assert_eq!(adaptive_thread_count(16, 20, 1_500, 1_000), 1);
        assert_eq!(adaptive_thread_count(16, 0, 10_000, 1_000), 1);
    }

    #[test]
    fn operation_aware_cache_reservation_keeps_render_stage_budget() {
        let analyze = cache_budget_bytes(PlanningOperation::Analyze, Some(8 * 1024 * 1024 * 1024));
        let render = cache_budget_bytes(PlanningOperation::Render, Some(8 * 1024 * 1024 * 1024));

        assert!(render > 0);
        assert!(render < analyze);
    }

    #[test]
    fn page_cache_paths_are_stable_without_decoder_policy() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-decode-cache-policy-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(32, 24, 240)).unwrap(),
        )
        .unwrap();
        let page = Page {
            input_path: input,
            analysis_input_path: None,
            analysis_dpi: None,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
            source_page_index: 0,
            page_metadata_path: dir.join("page.json"),
            options: CleanupOptions {
                output_mode: OutputMode::Color,
                ..CleanupOptions::default()
            },
            document_prior: None,
            detail_render_plan: None,
            outputs: Vec::new(),
        };
        let render_cache = manifest_cache(PlanningOperation::Render, None);
        let render_page_cache = page_cache_for(&planning_page(&page), &render_cache).unwrap();
        let render_key =
            crate::cache::StageCacheKey::decoded(&render_page_cache.source, true, &page.options);
        assert!(render_cache
            .lock()
            .unwrap()
            .get::<crate::io::raster::DecodedRaster>(&render_key)
            .is_none());

        let analyze_cache = manifest_cache(PlanningOperation::Analyze, None);
        let analyze_page_cache = page_cache_for(&planning_page(&page), &analyze_cache).unwrap();
        assert_eq!(analyze_page_cache.source, render_page_cache.source);
        assert!(analyze_cache
            .lock()
            .unwrap()
            .get::<crate::io::raster::DecodedRaster>(&render_key)
            .is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn trusted_ink_prepass_uses_the_bounded_page_pool() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-ink-prepass-bound-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        let mask = dir.join("foreground.png");
        let background = dir.join("background.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let mut selection = GrayImage::new(100, 50, 0);
        for y in 4..14 {
            for x in 10..90 {
                selection.set(x, y, 255);
            }
        }
        crate::png::write_gray_atomic(&mask, &selection).unwrap();
        crate::png::write_gray_atomic(&background, &GrayImage::new(50, 25, 240)).unwrap();
        let pages = (0..12)
            .map(|index| Page {
                input_path: input.clone(),
                analysis_input_path: None,
                analysis_dpi: None,
                trusted_foreground_mask_path: Some(mask.clone()),
                trusted_mrc_background_path: Some(background.clone()),
                source_page_index: index,
                page_metadata_path: dir.join(format!("page-{index}.json")),
                options: CleanupOptions {
                    output_mode: OutputMode::Bw,
                    source_has_bilevel_layer: true,
                    thickness: 0,
                    ..CleanupOptions::default()
                },
                document_prior: None,
                detail_render_plan: None,
                outputs: Vec::new(),
            })
            .collect::<Vec<_>>();
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages,
        };

        assert!(manifest_worker_threads(&manifest).unwrap() > 1);
        let samples = run_page_jobs(&manifest, |(_, page)| derive_page_ink_sample(page)).unwrap();
        let contexts = derive_page_ink_contexts(&samples);
        assert_eq!(contexts.len(), 12);
        assert!(contexts.iter().all(Option::is_some));
        assert_eq!(contexts[0], contexts[11]);
        let _ = fs::remove_dir_all(dir);
    }

    fn scheduler_test_manifest(dir: &Path, page_count: usize) -> ManifestV3 {
        let input = dir.join("scheduler-input.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            // For a 100x50 bilevel page this leaves exactly two page slots in
            // the memory-derived bound, independent of host CPU count.
            host_memory_bytes: Some(1_400_000),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..page_count)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("scheduler-page-{index}.json")),
                    options: CleanupOptions {
                        output_mode: OutputMode::Bw,
                        ..CleanupOptions::default()
                    },
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        }
    }

    #[test]
    fn page_dispatcher_maintains_a_sliding_bound_and_ordered_results() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-window-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 4);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);

        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let later_page_started_while_first_was_live = Arc::new(AtomicBool::new(false));
        let run = run_regular_page_jobs(
            &manifest,
            {
                let live = Arc::clone(&live);
                let peak = Arc::clone(&peak);
                let later_page_started_while_first_was_live =
                    Arc::clone(&later_page_started_while_first_was_live);
                move |(index, _)| {
                    let current = live.fetch_add(1, Ordering::AcqRel) + 1;
                    peak.fetch_max(current, Ordering::AcqRel);
                    if index == 0 {
                        // Keep the first slot occupied while page one completes;
                        // a sliding dispatcher must admit page two in that gap.
                        thread::sleep(Duration::from_millis(100));
                    } else if index == 2 && current >= 2 {
                        later_page_started_while_first_was_live.store(true, Ordering::Release);
                    }
                    live.fetch_sub(1, Ordering::AcqRel);
                    Ok::<_, NativeError>(index)
                }
            },
            2,
            2,
        )
        .unwrap();

        assert_eq!(run, vec![0, 1, 2, 3]);
        assert!(later_page_started_while_first_was_live.load(Ordering::Acquire));
        assert!(peak.load(Ordering::Acquire) <= 2);
        assert_eq!(live.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn page_dispatcher_completes_with_one_processing_thread() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-single-cpu-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 4);

        let run = run_regular_page_jobs(&manifest, |(index, _)| Ok::<_, NativeError>(index), 2, 1)
            .unwrap();

        assert_eq!(run, vec![0, 1, 2, 3]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn page_dispatcher_cancels_admission_and_settles_active_failures_in_order() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 5);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);

        let live = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let error = run_regular_page_jobs(
            &manifest,
            {
                let live = Arc::clone(&live);
                let started = Arc::clone(&started);
                move |(index, _)| {
                    live.fetch_add(1, Ordering::AcqRel);
                    started.lock().unwrap().push(index);
                    if index == 0 {
                        // Page one fails first in wall-clock time, while page zero
                        // remains an earlier submitted failure. The dispatcher
                        // must cancel page admission immediately, drain both
                        // active jobs, and retain the ordered error contract.
                        thread::sleep(Duration::from_millis(100));
                        live.fetch_sub(1, Ordering::AcqRel);
                        return Err(NativeError::new(
                            NativeErrorCode::NativeFailure,
                            "page 0 failed",
                        ));
                    }
                    if index == 1 {
                        live.fetch_sub(1, Ordering::AcqRel);
                        return Err(NativeError::new(
                            NativeErrorCode::NativeFailure,
                            "page 1 failed",
                        ));
                    }
                    live.fetch_sub(1, Ordering::AcqRel);
                    Ok(index)
                }
            },
            2,
            2,
        )
        .unwrap_err();

        assert!(error.to_string().contains("page 0 failed"));
        assert!(started.lock().unwrap().iter().all(|&index| index < 2));
        assert_eq!(live.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn page_dispatcher_settles_active_jobs_before_resuming_a_panic() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-panic-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 5);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);

        let live = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let live = Arc::clone(&live);
            let started = Arc::clone(&started);
            move || {
                let _ = run_regular_page_jobs(
                    &manifest,
                    move |(index, _)| {
                        live.fetch_add(1, Ordering::AcqRel);
                        started.lock().unwrap().push(index);
                        if index == 0 {
                            live.fetch_sub(1, Ordering::AcqRel);
                            panic!("page 0 panicked");
                        }
                        thread::sleep(Duration::from_millis(50));
                        live.fetch_sub(1, Ordering::AcqRel);
                        Ok::<_, NativeError>(index)
                    },
                    2,
                    2,
                );
            }
        }));

        let payload = panic.expect_err("dispatcher swallowed a page panic");
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"page 0 panicked"));
        assert!(started.lock().unwrap().iter().all(|&index| index < 2));
        assert_eq!(live.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn peak_page_estimate_tracks_measured_resident_high_water() {
        // Reference document, 2119x3204 gray page, 32-page Bw batch at five
        // workers, measured peak RSS 1.60 GB (audit-jul-25 U22 / SCP3). The
        // sizing model is cache budget plus one peak page per worker; it has to
        // land within +/-25 % of that or the worker budget admits threads the
        // host cannot hold.
        const MEASURED_PEAK_BYTES: f64 = 1.60e9;
        let modelled = cache_budget_bytes(PlanningOperation::Render, None) as f64
            + 5.0
                * estimate_peak_page_bytes(2119, 3204, PlanningOperation::Render, OutputMode::Bw)
                    as f64;
        let ratio = modelled / MEASURED_PEAK_BYTES;
        assert!(
            (0.75..=1.25).contains(&ratio),
            "modelled {modelled:.0} B is {ratio:.2}x the measured 1.60 GB peak",
        );
    }

    #[test]
    fn peak_page_estimate_accounts_for_rgb_analysis_and_auto_render() {
        let pixels = 2_000 * 1_500;
        let gray_render =
            estimate_peak_page_bytes(2_000, 1_500, PlanningOperation::Render, OutputMode::Bw);
        let analysis =
            estimate_peak_page_bytes(2_000, 1_500, PlanningOperation::Analyze, OutputMode::Bw);
        let auto_render =
            estimate_peak_page_bytes(2_000, 1_500, PlanningOperation::Render, OutputMode::Auto);

        assert_eq!(gray_render, pixels * 40);
        assert_eq!(analysis, pixels * 80);
        assert_eq!(auto_render, pixels * 80);
    }

    #[test]
    fn manifest_worker_sizing_applies_the_decode_policy() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-decode-policy-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let manifest = |operation, output_mode| ManifestV3 {
            version: VERSION,
            operation,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            // 600 kB remains after the process/cache split: enough for two
            // 40-Bpp pages, but only one 80-Bpp page.
            host_memory_bytes: Some(2_000_000),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..2)
                .map(|source_page_index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index,
                    page_metadata_path: dir.join(format!("page-{source_page_index}.json")),
                    options: CleanupOptions {
                        output_mode,
                        ..CleanupOptions::default()
                    },
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };

        assert_eq!(
            manifest_worker_threads(&manifest(Operation::Render, OutputMode::Bw)).unwrap(),
            2
        );
        assert_eq!(
            manifest_worker_threads(&manifest(Operation::Analyze, OutputMode::Bw)).unwrap(),
            1
        );
        assert_eq!(
            manifest_worker_threads(&manifest(Operation::Render, OutputMode::Auto)).unwrap(),
            1
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn analyze_workers_ignore_duplicate_unused_render_outputs() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-analyze-output-contract-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let duplicate_output = PageOutput {
            output_path: dir.join("unused.png"),
            metadata_path: dir.join("unused-output.json"),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..2)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: dir.join(format!("page-{index}.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: vec![duplicate_output.clone()],
                })
                .collect(),
        };

        // Analyze does not publish PageOutput destinations. Validation accepts
        // the duplicated unused values, while the worker bound still follows
        // the memory-derived page limit instead of a destination scan.
        manifest.validate().unwrap();
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn worker_sizing_follows_the_host_memory_the_manifest_reports() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-worker-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(2_000, 1_500, 240)).unwrap(),
        )
        .unwrap();
        let manifest = |host_memory_bytes| ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..8)
                .map(|index| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: index,
                    page_metadata_path: PathBuf::from("page.json"),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: Vec::new(),
                })
                .collect(),
        };
        let constrained = manifest_worker_threads(&manifest(Some(64 * 1024 * 1024))).unwrap();
        let roomy = manifest_worker_threads(&manifest(Some(32 * 1024 * 1024 * 1024))).unwrap();

        assert_eq!(constrained, 1);
        assert!(
            roomy > constrained,
            "a roomy host must not be sized like a 64 MiB one (roomy={roomy})"
        );
        assert_eq!(
            manifest_worker_threads(&manifest(None)).unwrap(),
            manifest_worker_threads(&manifest(Some(FALLBACK_SYSTEM_MEMORY_BYTES))).unwrap()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn color_peak_estimate_accounts_for_rgb_working_copies() {
        assert_eq!(
            estimate_peak_page_bytes(100, 50, PlanningOperation::Render, OutputMode::Bw),
            200_000
        );
        assert_eq!(
            estimate_peak_page_bytes(100, 50, PlanningOperation::Render, OutputMode::Color),
            400_000
        );
    }
}
