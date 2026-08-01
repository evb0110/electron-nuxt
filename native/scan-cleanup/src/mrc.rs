use scan_primitives::{
    morphology::{close, dilate, dilate_gray, erode_gray, open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, ComponentMap, GrayImage,
};
use std::collections::VecDeque;

fn fill_enclosed_holes(mask: &BinaryImage) -> BinaryImage {
    if mask.width() == 0 || mask.height() == 0 {
        return mask.clone();
    }
    let mut exterior = vec![false; mask.width().saturating_mul(mask.height())];
    let mut queue = VecDeque::new();
    let enqueue =
        |x: usize, y: usize, exterior: &mut [bool], queue: &mut VecDeque<(usize, usize)>| {
            let index = y * mask.width() + x;
            if !mask.get(x, y) && !exterior[index] {
                exterior[index] = true;
                queue.push_back((x, y));
            }
        };
    for x in 0..mask.width() {
        enqueue(x, 0, &mut exterior, &mut queue);
        enqueue(x, mask.height() - 1, &mut exterior, &mut queue);
    }
    for y in 0..mask.height() {
        enqueue(0, y, &mut exterior, &mut queue);
        enqueue(mask.width() - 1, y, &mut exterior, &mut queue);
    }
    while let Some((x, y)) = queue.pop_front() {
        if x > 0 {
            enqueue(x - 1, y, &mut exterior, &mut queue);
        }
        if x + 1 < mask.width() {
            enqueue(x + 1, y, &mut exterior, &mut queue);
        }
        if y > 0 {
            enqueue(x, y - 1, &mut exterior, &mut queue);
        }
        if y + 1 < mask.height() {
            enqueue(x, y + 1, &mut exterior, &mut queue);
        }
    }
    BinaryImage::from_fn_parallel(mask.width(), mask.height(), |x, y| {
        mask.get(x, y) || !exterior[y * mask.width() + x]
    })
}

fn reduce_rank4(mask: &BinaryImage) -> BinaryImage {
    let width = mask.width().div_ceil(2);
    let height = mask.height().div_ceil(2);
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let source_x = x * 2;
        let source_y = y * 2;
        source_x + 1 < mask.width()
            && source_y + 1 < mask.height()
            && mask.get(source_x, source_y)
            && mask.get(source_x + 1, source_y)
            && mask.get(source_x, source_y + 1)
            && mask.get(source_x + 1, source_y + 1)
    })
}

fn expand_replicate(mask: &BinaryImage, width: usize, height: usize, factor: usize) -> BinaryImage {
    if mask.width() == 0 || mask.height() == 0 {
        return BinaryImage::new(width, height);
    }
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        mask.get(
            (x / factor).min(mask.width() - 1),
            (y / factor).min(mask.height() - 1),
        )
    })
}

fn luminance_percentile(image: &GrayImage, numerator: usize, denominator: usize) -> u8 {
    debug_assert!(denominator > 0 && numerator <= denominator);
    let mut histogram = [0usize; 256];
    for &sample in image.data() {
        histogram[usize::from(sample)] += 1;
    }
    let target = image
        .data()
        .len()
        .saturating_sub(1)
        .saturating_mul(numerator)
        / denominator;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|count| {
            cumulative += count;
            cumulative > target
        })
        .unwrap_or(255) as u8
}

/// Reconstructs a photo plate from dense, spatially coherent tone evidence.
///
/// Illumination normalization intentionally removes broad fields, including a
/// photograph's smooth sky, wall, or bright clothing. The remaining textured
/// subjects and borders still describe the plate's footprint. Group them at a
/// physical scale and fill only groups whose original tone occupancy is dense
/// enough to distinguish a photograph or map from sparse text. This avoids
/// tying the decision to any absolute paper shade.
fn recover_dense_tonal_plates(mask: &BinaryImage, dpi: f64) -> BinaryImage {
    if mask.count_black() == 0 {
        return mask.clone();
    }
    let group_radius = (dpi * 6.0 / 25.4).round().clamp(2.0, 36.0) as usize;
    let grouped = ComponentMap::from_binary(&dilate(mask, group_radius, group_radius));
    let mut bounds =
        vec![None::<(usize, usize, usize, usize, usize)>; grouped.components().len() + 1];
    for y in 0..mask.height() {
        for x in 0..mask.width() {
            if !mask.get(x, y) {
                continue;
            }
            let label = grouped.label_at(x, y) as usize;
            if label == 0 {
                continue;
            }
            bounds[label] = Some(bounds[label].map_or(
                (x, y, x, y, 1),
                |(left, top, right, bottom, count)| {
                    (
                        left.min(x),
                        top.min(y),
                        right.max(x),
                        bottom.max(y),
                        count + 1,
                    )
                },
            ));
        }
    }
    let minimum_span = (dpi * 12.0 / 25.4).round().max(8.0) as usize;
    let candidates: Vec<_> = bounds
        .into_iter()
        .flatten()
        .map(|(left, top, right, bottom, count)| {
            let width = right - left + 1;
            let height = bottom - top + 1;
            let area = width.saturating_mul(height);
            let accepted = width >= minimum_span
                && height >= minimum_span
                // Sparse glyphs and show-through do not own their surrounding
                // paper. Dense photographic/map evidence does own smooth
                // highlights inside the same physical plate.
                && count.saturating_mul(5) >= area.saturating_mul(2);
            (left, top, right, bottom, count, area, accepted)
        })
        .collect();
    if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_MRC").is_some() {
        for &(left, top, right, bottom, count, area, accepted) in &candidates {
            eprintln!(
                "{{\"event\":\"mrc-tone-candidate\",\"left\":{left},\"top\":{top},\
                 \"right\":{right},\"bottom\":{bottom},\"tonePixels\":{count},\
                 \"area\":{area},\"occupancy\":{:.6},\"accepted\":{accepted}}}",
                count as f64 / area.max(1) as f64,
            );
        }
    }
    let accepted: Vec<_> = candidates
        .into_iter()
        .filter_map(|(left, top, right, bottom, count, _area, accepted)| {
            accepted.then_some((left, top, right, bottom, count))
        })
        .collect();
    if accepted.is_empty() {
        return mask.clone();
    }
    BinaryImage::from_fn_parallel(mask.width(), mask.height(), |x, y| {
        mask.get(x, y)
            || accepted.iter().any(|&(left, top, right, bottom, _)| {
                (left..=right).contains(&x) && (top..=bottom).contains(&y)
            })
    })
}

/// Derives recall-first continuous-tone ownership from a raw MRC background.
/// Evidence combines darkness relative to the page's own upper-quartile paper
/// with local texture. Illumination normalization is deliberately not used
/// because it absorbs smooth photograph and map fields. Opening removes thin
/// show-through strokes before connectivity, while physical dilation preserves
/// bright plate edges. Components made only of thin stroke texture (no solid
/// interior at ~0.6 mm) are verso show-through or scanner noise, never a
/// photograph, map fill, or meaningful tone plate, and are rejected before
/// consolidation.
pub(crate) fn derive_tone_mask(background: &GrayImage, dpi: f64) -> BinaryImage {
    let paper_reference = luminance_percentile(background, 3, 4);
    let texture_radius = (dpi * 0.45 / 25.4).round().clamp(1.0, 3.0) as usize;
    let local_max = erode_gray(background, texture_radius, texture_radius);
    let local_min = dilate_gray(background, texture_radius, texture_radius);
    // Scanner grain and codec ringing raise the whole page's local range, so
    // a fixed texture floor claims grainy paper wholesale. The page's median
    // local range measures that noise floor; genuine photo/map texture sits
    // well above twice it.
    let mut range_histogram = [0usize; 256];
    for index in 0..background.data().len() {
        let x = index % background.width();
        let y = index / background.width();
        let range = local_max.get(x, y).saturating_sub(local_min.get(x, y));
        range_histogram[usize::from(range)] += 1;
    }
    let mut cumulative = 0usize;
    let median_range = range_histogram
        .iter()
        .position(|count| {
            cumulative += count;
            cumulative * 2 > background.data().len()
        })
        .unwrap_or(0) as u8;
    let texture_threshold = median_range.saturating_mul(2).max(12);
    let dark_threshold = paper_reference.saturating_sub(texture_threshold.max(10));
    if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_MRC").is_some() {
        eprintln!(
            "{{\"event\":\"mrc-plate-evidence\",\"paperReference\":{paper_reference},\
             \"darkThreshold\":{dark_threshold},\"textureThreshold\":{texture_threshold}}}",
        );
    }
    let evidence =
        BinaryImage::from_fn_parallel(background.width(), background.height(), |x, y| {
            background.get(x, y) < dark_threshold
                || local_max.get(x, y).saturating_sub(local_min.get(x, y)) >= texture_threshold
        });
    let opening_radius = (dpi * 0.35 / 25.4).round().clamp(1.0, 3.0) as usize;
    let opened = open(&evidence, opening_radius, opening_radius);
    let components = ComponentMap::from_binary(&opened);
    let minimum_span = (dpi * 3.0 / 25.4).round().max(4.0) as usize;
    let seeded = components.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        width >= minimum_span && height >= minimum_span
    });
    let core_radius = (dpi * 0.6 / 25.4).round().clamp(2.0, 6.0) as usize;
    let solid_cores = open(&seeded, core_radius, core_radius);
    let seeded_components = ComponentMap::from_binary(&seeded);
    let mut core_counts = vec![0usize; seeded_components.components().len() + 1];
    for y in 0..background.height() {
        for x in 0..background.width() {
            if !solid_cores.get(x, y) {
                continue;
            }
            let label = seeded_components.label_at(x, y) as usize;
            if label > 0 {
                core_counts[label] += 1;
            }
        }
    }
    let seeded = seeded_components.retain(|component| {
        core_counts[component.label as usize].saturating_mul(100)
            >= component.area.saturating_mul(12)
    });
    let close_radius = (dpi * 0.8 / 25.4).round().clamp(1.0, 5.0) as usize;
    let edge_recall_radius = (dpi * 1.5 / 25.4).round().clamp(2.0, 9.0) as usize;
    let connected_tone = fill_enclosed_holes(&dilate(
        &close(&seeded, close_radius, close_radius),
        edge_recall_radius,
        edge_recall_radius,
    ));
    connected_tone.or(&recover_dense_tonal_plates(&seeded, dpi))
}

fn project_foreground_ownership(
    foreground: &BinaryImage,
    width: usize,
    height: usize,
) -> BinaryImage {
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        let left = x.saturating_mul(foreground.width()) / width.max(1);
        let right = (x + 1)
            .saturating_mul(foreground.width())
            .div_ceil(width.max(1))
            .min(foreground.width());
        let top = y.saturating_mul(foreground.height()) / height.max(1);
        let bottom = (y + 1)
            .saturating_mul(foreground.height())
            .div_ceil(height.max(1))
            .min(foreground.height());
        (top..bottom)
            .any(|source_y| (left..right).any(|source_x| foreground.get(source_x, source_y)))
    })
}

/// Derives background-owned tone by rejecting foreground ghost components.
///
/// Ghost components fully inside the projected foreground's dilated resampling
/// footprint, with no coherent interior beyond it, are rejected whole.
/// Components with any coherent unexplained interior are genuine photo, map,
/// or fill tone and are kept whole, because MRC producers routinely select
/// picture texture into the foreground and pixel-level subtraction would carve
/// holes through the plate.
pub(crate) fn derive_tone_mask_excluding_foreground(
    background: &GrayImage,
    dpi: f64,
    foreground: &BinaryImage,
) -> BinaryImage {
    let projected =
        project_foreground_ownership(foreground, background.width(), background.height());
    let resampling_radius = (dpi * 0.6 / 25.4).round().clamp(1.0, 8.0) as usize;
    let tone_growth_radius = (dpi * 1.5 / 25.4).round().clamp(2.0, 9.0) as usize;
    let residual_influence_radius = resampling_radius + tone_growth_radius;
    let residual_influence = dilate(
        &projected,
        residual_influence_radius,
        residual_influence_radius,
    );
    let tone = derive_tone_mask(background, dpi);
    let unexplained = open(
        &tone.subtract(&residual_influence),
        resampling_radius,
        resampling_radius,
    );
    let components = ComponentMap::from_binary(&tone);
    let mut unexplained_counts = vec![0usize; components.components().len() + 1];
    for y in 0..background.height() {
        for x in 0..background.width() {
            if !unexplained.get(x, y) {
                continue;
            }
            let label = components.label_at(x, y) as usize;
            if label > 0 {
                unexplained_counts[label] += 1;
            }
        }
    }
    components.retain(|component| unexplained_counts[component.label as usize] > 0)
}

pub(crate) fn derive_halftone_zones(gray: &GrayImage, dpi: f64) -> BinaryImage {
    if gray.width() == 0 || gray.height() == 0 {
        return BinaryImage::new(gray.width(), gray.height());
    }
    let binary = threshold_local(
        gray,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        },
    );
    let reduced = reduce_rank4(&reduce_rank4(&binary));
    let mass_seed = expand_replicate(&open(&reduced, 2, 2), gray.width(), gray.height(), 4);
    // A photograph at analysis scale offers one of two signals: dense dark
    // MASS (shadows, printed halftone) that survives the rank cascade, or
    // smooth MID-GRAY fields (skin, stone, sky) that binarize to nothing.
    // Text and line art offer neither — type is paper-and-ink, hatching is
    // edge, not field. Seed from both signals; the verdict below rejects
    // whatever line art sneaks through on mass alone. Bold type survives
    // the cascade only as isolated pellets, which the smoothness-free
    // 2 mm density test cannot turn into fields, and whose tight tonal
    // concentration the spread verdict rejects.
    let texture_radius = (dpi * 0.45 / 25.4).round().clamp(1.0, 3.0) as usize;
    // Edge statistics run on a lightly blurred plane: halftone dots are
    // finer than pen strokes, so a one-stroke-width mean filter collapses a
    // printed photograph's dot micro-contrast while hatching and engraved
    // lines keep theirs.
    let blurred = box_mean_gray(gray, 1);
    let local_max = erode_gray(&blurred, texture_radius, texture_radius);
    let local_min = dilate_gray(&blurred, texture_radius, texture_radius);
    let paper_reference = luminance_percentile(gray, 3, 4);
    // The ceiling sits at genuine-tone depth: verso show-through is
    // attenuated by the paper and stays within ~45 of the paper shade, so
    // it must never seed a smooth field, or its page-wide tiles chain
    // every cluster together.
    let smooth_ceiling = paper_reference.saturating_sub(45);
    let smooth_candidates = BinaryImage::from_fn_parallel(gray.width(), gray.height(), |x, y| {
        let value = gray.get(x, y);
        value > 64
            && value < smooth_ceiling
            && local_max.get(x, y).saturating_sub(local_min.get(x, y)) <= 12
    });
    let density_radius = (dpi * 2.0 / 25.4).round().clamp(2.0, 16.0) as usize;
    let smooth_seed = filter_dense_regions(&smooth_candidates, density_radius);
    let seed = mass_seed.or(&smooth_seed);
    // Reconstruction recovers the photo's bright remainder through the
    // closed binary, but each seed CLUSTER grows inside its own clipped
    // neighborhood and is judged alone: a photograph two text lines away
    // from a show-through field must not share a verdict with it, and a
    // chain of incidental bridges must never merge a picture with a text
    // column before the tonal tests run.
    let growth_radius = (dpi * 8.0 / 25.4).round().clamp(4.0, 64.0) as usize;
    let cluster_radius = (dpi * 2.0 / 25.4).round().clamp(2.0, 24.0) as usize;
    let closed = close(&binary, 4, 4);
    let clusters = ComponentMap::from_binary(&dilate(&seed, cluster_radius, cluster_radius));
    let cluster_count = clusters.components().len();
    let minimum_span = (dpi * 12.0 / 25.4).round().max(8.0) as usize;
    let mut candidates = BinaryImage::new(gray.width(), gray.height());
    for cluster_index in 0..cluster_count {
        let cluster = &clusters.components()[cluster_index];
        let label = cluster.label;
        let span_x = cluster.right - cluster.left + 1;
        let span_y = cluster.bottom - cluster.top + 1;
        if span_x < minimum_span || span_y < minimum_span {
            continue;
        }
        let cluster_seed = BinaryImage::from_fn_parallel(gray.width(), gray.height(), |x, y| {
            seed.get(x, y) && clusters.label_at(x, y) == label
        });
        let growth_zone = dilate(&cluster_seed, growth_radius, growth_radius);
        let clipped_mask = BinaryImage::from_fn_parallel(gray.width(), gray.height(), |x, y| {
            closed.get(x, y) && growth_zone.get(x, y)
        });
        let region = reconstruct_binary(&cluster_seed, &clipped_mask);
        candidates = candidates.or(&region);
    }
    let sized = ComponentMap::from_binary(&candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        width >= minimum_span && height >= minimum_span
    });
    let candidates = fill_enclosed_holes(&sized);
    // Two verdicts separate photographs from line art that also carries
    // mass or smooth fields. SPREAD: a photograph's tones scatter away
    // from both the ink core and the paper core; line art concentrates at
    // both. EDGE DENSITY: hatching, engraving and type are made of strokes
    // — a large share of their pixels sit on strong local gradients —
    // while photographic fields are smooth almost everywhere.
    let paper_core_floor = paper_reference.saturating_sub(20);
    let regions = ComponentMap::from_binary(&candidates);
    let mut histograms = vec![[0usize; 256]; regions.components().len() + 1];
    let mut edge_counts = vec![0usize; regions.components().len() + 1];
    for y in 0..gray.height() {
        for x in 0..gray.width() {
            let label = regions.label_at(x, y) as usize;
            if label > 0 {
                histograms[label][usize::from(gray.get(x, y))] += 1;
                if local_max.get(x, y).saturating_sub(local_min.get(x, y)) >= 48 {
                    edge_counts[label] += 1;
                }
            }
        }
    }
    regions.retain(|component| {
        let histogram = &histograms[component.label as usize];
        let total: usize = histogram.iter().sum();
        if total == 0 {
            return false;
        }
        let mut cumulative = 0usize;
        let ink_reference = histogram
            .iter()
            .position(|&count| {
                cumulative += count;
                cumulative * 10 > total
            })
            .unwrap_or(0) as u8;
        let ink_core_ceiling = ink_reference.saturating_add(20);
        let spread: usize = histogram
            .iter()
            .enumerate()
            .filter(|&(value, _)| {
                value > usize::from(ink_core_ceiling) && value < usize::from(paper_core_floor)
            })
            .map(|(_, &count)| count)
            .sum();
        let edge_fraction = edge_counts[component.label as usize] as f64 / total as f64;
        if std::env::var_os("EVB_SCAN_CLEANUP_TRACE_MRC").is_some() {
            eprintln!(
                "{{\"event\":\"halftone-region\",\"left\":{},\"top\":{},\"right\":{},\
                 \"bottom\":{},\"area\":{},\"inkReference\":{ink_reference},\
                 \"paperCoreFloor\":{paper_core_floor},\"spreadFraction\":{:.4},\
                 \"edgeFraction\":{edge_fraction:.4}}}",
                component.left,
                component.top,
                component.right,
                component.bottom,
                component.area,
                spread as f64 / total as f64,
            );
        }
        spread.saturating_mul(4) >= total && edge_fraction < 0.55
    })
}

fn box_mean_gray(image: &GrayImage, radius: usize) -> GrayImage {
    let width = image.width();
    let height = image.height();
    if width == 0 || height == 0 {
        return image.clone();
    }
    let mut integral = vec![0u64; (width + 1) * (height + 1)];
    for y in 0..height {
        let mut row_sum = 0u64;
        for x in 0..width {
            row_sum += u64::from(image.get(x, y));
            integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row_sum;
        }
    }
    let mut output = image.clone();
    for y in 0..height {
        for x in 0..width {
            let left = x.saturating_sub(radius);
            let top = y.saturating_sub(radius);
            let right = (x + radius + 1).min(width);
            let bottom = (y + radius + 1).min(height);
            let sum = integral[bottom * (width + 1) + right] + integral[top * (width + 1) + left]
                - integral[top * (width + 1) + right]
                - integral[bottom * (width + 1) + left];
            let window = ((right - left) * (bottom - top)) as u64;
            output.set(x, y, (sum / window.max(1)) as u8);
        }
    }
    output
}

/// Keeps mask pixels whose 2-D neighborhood is at least a third occupied by
/// the mask; isolated marks and thin strokes fall below the ratio.
fn filter_dense_regions(mask: &BinaryImage, radius: usize) -> BinaryImage {
    let width = mask.width();
    let height = mask.height();
    if width == 0 || height == 0 {
        return mask.clone();
    }
    let mut integral = vec![0u64; (width + 1) * (height + 1)];
    for y in 0..height {
        let mut row_sum = 0u64;
        for x in 0..width {
            row_sum += u64::from(mask.get(x, y));
            integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row_sum;
        }
    }
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        if !mask.get(x, y) {
            return false;
        }
        let left = x.saturating_sub(radius);
        let top = y.saturating_sub(radius);
        let right = (x + radius + 1).min(width);
        let bottom = (y + radius + 1).min(height);
        let count = integral[bottom * (width + 1) + right] + integral[top * (width + 1) + left]
            - integral[top * (width + 1) + right]
            - integral[bottom * (width + 1) + left];
        let window = ((right - left) * (bottom - top)) as u64;
        count.saturating_mul(3) >= window
    })
}

pub(crate) fn derive_picture_zones(
    _tone: &BinaryImage,
    background: &GrayImage,
    dpi: f64,
) -> BinaryImage {
    derive_halftone_zones(background, dpi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dense_random_photo_texture_survives_as_a_zone() {
        // A photograph at analysis scale: contiguous shadow masses beside
        // midtone fields, not a uniform ink slab and not per-pixel noise.
        let mut image = GrayImage::new(320, 320, 255);
        for y in 48..272 {
            for x in 48..272 {
                let cell = (x / 24 + y / 24) % 2 == 0;
                let value = if cell {
                    30 + ((x * 37 + y * 61) % 24) as u8
                } else {
                    120 + ((x * 13 + y * 41) % 48) as u8
                };
                image.set(x, y, value);
            }
        }
        let zones = derive_halftone_zones(&image, 150.0);
        assert!(zones.get(160, 160));
        assert!(!zones.get(20, 20));
    }

    #[test]
    fn one_pixel_hatching_does_not_seed_a_zone() {
        let mut image = GrayImage::new(320, 320, 255);
        for y in (48..272).step_by(4) {
            for x in 48..272 {
                image.set(x, y, 20);
            }
        }
        for x in (48..272).step_by(4) {
            for y in 48..272 {
                image.set(x, y, 20);
            }
        }
        assert_eq!(derive_halftone_zones(&image, 150.0).count_black(), 0);
    }

    #[test]
    fn text_lines_do_not_seed_a_zone() {
        let mut image = GrayImage::new(320, 320, 255);
        for y in (48..272).step_by(9) {
            for x in 48..272 {
                image.set(x, y, 20);
            }
        }
        assert_eq!(derive_halftone_zones(&image, 150.0).count_black(), 0);
    }

    #[test]
    fn hole_fill_keeps_a_bright_photo_interior() {
        let mut image = GrayImage::new(320, 320, 255);
        for y in 48..272 {
            for x in 48..272 {
                if !(112..208).contains(&x) || !(112..208).contains(&y) {
                    let cell = (x / 24 + y / 24) % 2 == 0;
                    let value = if cell {
                        30 + ((x * 37 + y * 61) % 24) as u8
                    } else {
                        120 + ((x * 13 + y * 41) % 48) as u8
                    };
                    image.set(x, y, value);
                }
            }
        }
        let zones = derive_halftone_zones(&image, 150.0);
        assert!(zones.get(160, 160));
        assert!(!zones.get(20, 20));
    }

    #[test]
    fn uniform_tinted_paper_has_no_tone_plate() {
        for paper in [72u8, 112, 152, 192, 232] {
            let background = GrayImage::new(240, 320, paper);
            assert_eq!(derive_tone_mask(&background, 120.0).count_black(), 0);
        }
    }

    #[test]
    fn a_photo_touching_the_page_edge_keeps_its_bright_border() {
        let mut background = GrayImage::new(240, 320, 210);
        for y in 55..265 {
            for x in 85..240 {
                let value = if x > 232 {
                    242
                } else {
                    35 + ((x * 7 + y * 11) % 180) as u8
                };
                background.set(x, y, value);
            }
        }
        let tone = derive_tone_mask(&background, 120.0);
        assert!(tone.get(238, 160), "bright photo edge must remain tonal");
        assert!(!tone.get(30, 290), "uniform paper must stay outside tone");
    }

    #[test]
    fn bright_highlights_enclosed_by_a_photo_plate_remain_tonal() {
        let mut background = GrayImage::new(240, 320, 205);
        for y in 45..255 {
            for x in 55..185 {
                let is_bright_highlight = (88..155).contains(&x) && (82..220).contains(&y);
                background.set(
                    x,
                    y,
                    if is_bright_highlight {
                        248
                    } else {
                        30 + ((x * 13 + y * 7) % 155) as u8
                    },
                );
            }
        }
        let tone = derive_tone_mask(&background, 120.0);
        assert!(
            tone.get(120, 140),
            "an enclosed bright highlight belongs to the photo plate"
        );
        assert!(!tone.get(25, 280), "paper outside the plate stays paper");
    }

    #[test]
    fn disconnected_subjects_reconstruct_their_shared_photo_plate() {
        let mut background = GrayImage::new(300, 360, 184);
        // A smooth, moderately darker photo field is deliberately easy for an
        // illumination model to absorb. The disconnected textured subjects
        // must still recover the bright center between them.
        for y in 55..225 {
            for x in 45..255 {
                background.set(x, y, 154);
            }
        }
        for y in 75..205 {
            for x in 65..125 {
                background.set(x, y, 35 + ((x * 11 + y * 7) % 105) as u8);
            }
            for x in 175..235 {
                background.set(x, y, 45 + ((x * 5 + y * 13) % 95) as u8);
            }
        }
        let tone = derive_tone_mask(&background, 120.0);
        assert!(
            tone.get(150, 140),
            "the smooth region between dense subjects belongs to the photo"
        );
        assert!(!tone.get(20, 320), "uniform tinted paper remains paper");
    }

    #[test]
    fn sparse_text_on_tinted_paper_does_not_claim_the_page_between_glyphs() {
        for paper in [72u8, 112, 152, 192, 232] {
            let ink = paper.saturating_sub(52);
            let mut background = GrayImage::new(300, 360, paper);
            for row in 0..18 {
                let top = 28 + row * 16;
                for x in 30..270 {
                    if (x / 9 + row) % 3 != 0 {
                        background.set(x, top, ink);
                        background.set(x, top + 1, ink);
                    }
                }
            }
            let tone = derive_tone_mask(&background, 120.0);
            assert!(
                !tone.get(150, 22),
                "sparse text must not turn the paper between rows into a tone plate at shade {paper}"
            );
            assert!(
                tone.count_black() < background.width() * background.height() / 3,
                "sparse text must not claim a large tinted-paper field at shade {paper}"
            );
        }
    }

    #[test]
    fn scattered_semantic_tones_do_not_become_a_solid_rectangle() {
        let mut mask = BinaryImage::new(300, 360);
        for left in [55, 97, 139, 181] {
            for y in 80..230 {
                for x in left..left + 10 {
                    mask.set(x, y, true);
                }
            }
        }
        let recovered = recover_dense_tonal_plates(&mask, 120.0);
        assert!(
            !recovered.get(85, 150),
            "scattered map fills must not claim the paper between them"
        );
        assert!(
            recovered.get(100, 150),
            "the authored gray fill remains tonal"
        );
    }

    #[test]
    fn page_relative_gray_map_fills_keep_their_shape_on_tinted_paper() {
        for paper in [92u8, 132, 172, 212] {
            let mut background = GrayImage::new(320, 360, paper);
            let fill = paper.saturating_sub(42);
            for left in [45, 113, 181, 249] {
                for y in 80..230 {
                    for x in left..left + 18 {
                        background.set(x, y, fill);
                    }
                }
                // Texture evidence anchors each authored tone component.
                for y in (88..222).step_by(9) {
                    for x in left + 3..left + 8 {
                        background.set(x, y, fill.saturating_sub(30));
                    }
                }
            }
            let tone = derive_tone_mask(&background, 120.0);
            assert!(
                tone.get(52, 150),
                "authored gray fill must remain tonal at paper shade {paper}"
            );
            assert!(
                !tone.get(90, 150),
                "paper between distinct map fills must become white at shade {paper}"
            );
        }
    }

    #[test]
    fn faint_stroke_show_through_is_not_tone_but_a_solid_pale_fill_is() {
        let mut background = GrayImage::new(300, 360, 200);
        // Verso show-through: a large carpet of thin faint horizontal strokes.
        for row in 0..24 {
            let y = 20 + row * 9;
            for x in 30..270 {
                if (x / 7 + row) % 3 != 0 {
                    background.set(x, y, 175);
                    background.set(x, y + 1, 178);
                }
            }
        }
        // A meaningful pale fill: solid, same shallow depth, 16 px wide.
        for y in 250..340 {
            for x in 40..120 {
                background.set(x, y, 175);
            }
        }
        let tone = derive_tone_mask(&background, 120.0);
        assert!(
            !tone.get(150, 100),
            "a stroke-textured show-through carpet must remain paper"
        );
        assert!(
            tone.get(80, 295),
            "a solid pale fill of the same depth remains tonal"
        );
    }

    #[test]
    fn foreground_ghost_is_not_background_tone_but_unselected_fill_survives() {
        let mut background = GrayImage::new(120, 160, 190);
        let mut foreground = BinaryImage::new(360, 480);
        for row in 0..9 {
            let y = 24 + row * 12;
            for x in 15..85 {
                if (x + row) % 4 != 0 {
                    background.set(x, y, 132);
                    background.set(x, y + 1, 142);
                    for foreground_y in y * 3..(y + 2) * 3 {
                        for foreground_x in x * 3..(x + 1) * 3 {
                            foreground.set(foreground_x, foreground_y, true);
                        }
                    }
                }
            }
        }
        for y in 55..125 {
            for x in 92..112 {
                background.set(x, y, 70 + ((x * 17 + y * 11) % 90) as u8);
            }
        }

        let tone = derive_tone_mask_excluding_foreground(&background, 120.0, &foreground);
        assert!(
            !tone.get(48, 48),
            "foreground-aligned ghost strokes must remain paper"
        );
        assert!(
            tone.get(102, 88),
            "unselected authored tone remains background-owned"
        );
        // The adjacent photo plate legitimately owns a recall margin (texture
        // halo plus edge-recall dilation) that reaches x=83; the ghost
        // rejection contract applies to everything left of that margin.
        assert!(
            (15..83).all(|x| (24..122).all(|y| !tone.get(x, y))),
            "the complete foreground-aligned ghost must be rejected, including grown halos"
        );
    }

    /// Developer diagnostic for inspecting tone ownership on an extracted MRC
    /// background without running the full PDF pipeline.
    ///
    /// Run with:
    /// `EVB_MRC_BACKGROUND=/path/to/background.png EVB_MRC_TONE_MASK=/tmp/tone.pbm
    /// cargo test -p evb-scan-cleanup dump_external_mrc_tone_mask -- --ignored`
    #[test]
    /// Developer diagnostic: run the halftone classifier on an external image.
    /// `EVB_HALFTONE_IMAGE=/path.png EVB_SCAN_CLEANUP_TRACE_MRC=1
    /// cargo test -p evb-scan-cleanup dump_halftone_zones -- --ignored --nocapture`
    #[test]
    #[ignore = "requires EVB_HALFTONE_IMAGE"]
    fn dump_halftone_zones() {
        let path = std::env::var("EVB_HALFTONE_IMAGE").unwrap();
        let image = crate::io::raster::read_image(std::path::Path::new(&path), 40_000_000, 10_000)
            .unwrap();
        let dpi = std::env::var("EVB_HALFTONE_DPI")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(150.0);
        let zones = derive_halftone_zones(&image.gray, dpi);
        eprintln!("halftone zone pixels: {}", zones.count_black());
    }

    #[ignore = "requires EVB_MRC_BACKGROUND and EVB_MRC_TONE_MASK"]
    fn dump_external_mrc_tone_mask() {
        let input_path = std::env::var("EVB_MRC_BACKGROUND").unwrap();
        let output_path = std::env::var("EVB_MRC_TONE_MASK").unwrap();
        let background =
            crate::io::raster::read_image(std::path::Path::new(&input_path), 20_000_000, 10_000)
                .unwrap();
        let texture_radius = 2;
        let local_max = erode_gray(&background.gray, texture_radius, texture_radius);
        let local_min = dilate_gray(&background.gray, texture_radius, texture_radius);
        let paper_reference = luminance_percentile(&background.gray, 3, 4);
        let dark_threshold = paper_reference.saturating_sub(10);
        let evidence = BinaryImage::from_fn_parallel(
            background.gray.width(),
            background.gray.height(),
            |x, y| {
                background.gray.get(x, y) < dark_threshold
                    || local_max.get(x, y).saturating_sub(local_min.get(x, y)) >= 10
            },
        );
        let tone = derive_tone_mask(&background.gray, 120.0);
        eprintln!(
            "tone coverage: {}/{} ({:.2}%)",
            tone.count_black(),
            tone.width() * tone.height(),
            tone.count_black() as f64 / (tone.width() * tone.height()).max(1) as f64 * 100.0,
        );
        let output_path = std::path::Path::new(&output_path);
        crate::io::pbm::write_p4_bilevel_atomic(output_path, &tone).unwrap();
        crate::io::pbm::write_p4_bilevel_atomic(&output_path.with_extension("weak.pbm"), &evidence)
            .unwrap();
    }
}
