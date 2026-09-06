//! Typed handoff for final raster composition.

use super::*;

pub(crate) struct Input<'a> {
    pub gray: &'a GrayImage,
    pub raw_gray: Option<&'a GrayImage>,
    pub color: Option<&'a RgbImage>,
    pub binary: &'a BinaryImage,
    pub picture_mask: &'a BinaryImage,
    pub chroma_picture_mask: Option<&'a BinaryImage>,
    pub removed_edge_bands: Option<&'a BinaryImage>,
    pub text_mask: Option<&'a BinaryImage>,
    pub text_vicinity_mask: Option<&'a BinaryImage>,
    pub dpi: f64,
    pub preserve_confirmed_photo_tones: bool,
    pub use_soft_alpha_foreground: bool,
    pub create_layers: bool,
    pub create_composite: bool,
}

pub(crate) fn run(input: Input<'_>) -> (GrayImage, Option<RgbImage>, Option<MixedLayers>) {
    let Input {
        gray,
        raw_gray,
        color,
        binary,
        picture_mask,
        chroma_picture_mask,
        removed_edge_bands,
        text_mask,
        text_vicinity_mask,
        dpi,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        create_layers,
        create_composite,
    } = input;
    // Mixed has two mutually exclusive owners: the binary foreground owns
    // text, while the protected picture mask owns continuous-tone detail.
    // Binarization already excludes this area, but later text-recall and
    // source-ink-support passes can add pixels back. Enforce the ownership
    // boundary at the composition boundary so every Mixed path, including
    // soft-alpha composition, has the same protection against leaked ink.
    let protection_radius = picture_protection_radius(dpi);
    let protected_picture_mask = dilate(picture_mask, protection_radius, protection_radius);
    let owned_binary = binary.subtract(&protected_picture_mask);
    debug_assert_eq!(
        owned_binary.and(&protected_picture_mask).count_black(),
        0,
        "Mixed foreground must not overlap protected picture ownership"
    );
    let binary = &owned_binary;
    if use_soft_alpha_foreground {
        return compose_soft_alpha_mixed(
            gray,
            raw_gray,
            color,
            binary,
            picture_mask,
            chroma_picture_mask,
            removed_edge_bands,
            text_mask,
            text_vicinity_mask,
            dpi,
            preserve_confirmed_photo_tones,
            create_layers,
            create_composite,
        );
    }
    // The final stencil and the calibrated picture mask are both rebuilt from
    // the cleaned raster. Start the background at neutral white so no
    // producer-authored composite or unclassified scanner tone can travel
    // into the output. The narrow picture ring may reclaim genuinely dark
    // boundary detail, but pale pixels outside the calibrated zone remain
    // white.
    let mut mixed_gray = GrayImage::new(gray.width(), gray.height(), 255);
    // A color plane is only produced when the page owns independent chroma.
    // Scanner noise keeps neutral pages from ever measuring exactly r=g=b,
    // so publishing RGB here forces every downstream encoder into a
    // three-channel JPEG at ~3x the bytes for tone the gray plane already
    // carries.
    let mut mixed_color = color
        .filter(|_| chroma_picture_mask.is_some())
        .map(|_| RgbImage::new(gray.width(), gray.height(), [255; 3]));
    let feather_radius = (dpi * 3.0 / 25.4).round().clamp(4.0, 48.0) as usize;
    let picture_exterior = picture_mask.invert();
    let (distance_to_picture_exterior, distance_to_stencil) = rayon::join(
        || squared_euclidean_distance(&picture_exterior),
        || squared_euclidean_distance(binary),
    );
    let stencil_adjacency_squared = (feather_radius * feather_radius) as u32;
    let alpha_at = |x: usize, y: usize, source_gray: u8| {
        let index = y * gray.width() + x;
        if preserve_confirmed_photo_tones {
            // Every pixel inside a corroborated owner is source appearance, including
            // the rectangular crop's paper-toned boundary. Any protective transition
            // belongs to the exterior ring below; fading owner pixels toward white
            // recreates the tile-shaped halo this path exists to remove.
            1.0
        } else if distance_to_stencil[index] <= stencil_adjacency_squared {
            let spatial_alpha = (f64::from(distance_to_picture_exterior[index]).sqrt()
                / feather_radius as f64)
                .clamp(0.0, 1.0);
            let dark_detail_alpha = ((245.0 - f64::from(source_gray)) / 96.0).clamp(0.0, 1.0);
            spatial_alpha.max(dark_detail_alpha)
        } else {
            1.0
        }
    };
    if let (Some(source_color), Some(output_color)) = (color, mixed_color.as_mut()) {
        mixed_gray
            .data_mut()
            .par_chunks_mut(gray.width())
            .zip(output_color.data_mut().par_chunks_mut(gray.width() * 3))
            .enumerate()
            .for_each(|(y, (gray_row, color_row))| {
                for (x, gray_target) in gray_row.iter_mut().enumerate() {
                    if removed_edge_bands.is_some_and(|mask| mask.get(x, y)) {
                        *gray_target = 255;
                        color_row[x * 3..x * 3 + 3].fill(255);
                        continue;
                    }
                    if binary.get(x, y) {
                        let value = if create_composite { 0 } else { 255 };
                        *gray_target = value;
                        color_row[x * 3..x * 3 + 3].fill(value);
                        continue;
                    }
                    if !protected_picture_mask.get(x, y) {
                        continue;
                    }
                    let source_gray = gray.get(x, y);
                    let inside_picture = picture_mask.get(x, y);
                    let alpha = if inside_picture {
                        alpha_at(x, y, source_gray)
                    } else {
                        ((200.0 - f64::from(source_gray)) / 80.0).clamp(0.0, 1.0)
                    };
                    let exact_owned_tone = preserve_confirmed_photo_tones && inside_picture;
                    let paper_ring = !inside_picture && alpha <= f64::EPSILON;
                    *gray_target = if exact_owned_tone {
                        source_gray
                    } else if paper_ring {
                        255
                    } else {
                        reserve_gray_endpoint(
                            (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8,
                        )
                    };
                    let rgb = if exact_owned_tone {
                        source_color.get(x, y)
                    } else if paper_ring {
                        [255; 3]
                    } else {
                        reserve_rgb_endpoints(source_color.get(x, y).map(|channel| {
                            (255.0 * (1.0 - alpha) + f64::from(channel) * alpha)
                                .round()
                                .clamp(0.0, 255.0) as u8
                        }))
                    };
                    color_row[x * 3..x * 3 + 3].copy_from_slice(&rgb);
                }
            });
    } else {
        mixed_gray
            .data_mut()
            .par_chunks_mut(gray.width())
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.iter_mut().enumerate() {
                    if removed_edge_bands.is_some_and(|mask| mask.get(x, y)) {
                        *target = 255;
                        continue;
                    }
                    if binary.get(x, y) {
                        *target = if create_composite { 0 } else { 255 };
                    } else if protected_picture_mask.get(x, y) {
                        let source_gray = gray.get(x, y);
                        let inside_picture = picture_mask.get(x, y);
                        let alpha = if inside_picture {
                            alpha_at(x, y, source_gray)
                        } else {
                            ((200.0 - f64::from(source_gray)) / 80.0).clamp(0.0, 1.0)
                        };
                        *target = if preserve_confirmed_photo_tones && inside_picture {
                            source_gray
                        } else if !inside_picture && alpha <= f64::EPSILON {
                            255
                        } else {
                            reserve_gray_endpoint(
                                (255.0 * (1.0 - alpha) + f64::from(source_gray) * alpha)
                                    .round()
                                    .clamp(0.0, 255.0) as u8,
                            )
                        };
                    }
                }
            });
    }
    let layers = create_layers.then(|| {
        let foreground_mask = binary.clone();
        let mut background = mixed_gray.clone();
        let mut color_background = mixed_color.clone();
        if !create_composite {
            fill_picture_stencil_knockouts(
                &mut background,
                color_background.as_mut(),
                binary,
                &protected_picture_mask,
                dpi,
            );
            return MixedLayers {
                foreground_mask,
                foreground_alpha: None,
                background,
                color_background,
                source_mrc: false,
            };
        }
        if let Some(color_background) = color_background.as_mut() {
            background
                .data_mut()
                .par_chunks_mut(gray.width())
                .zip(color_background.data_mut().par_chunks_mut(gray.width() * 3))
                .enumerate()
                .for_each(|(y, (gray_row, color_row))| {
                    for (x, target) in gray_row.iter_mut().enumerate() {
                        if binary.get(x, y) {
                            *target = 255;
                            color_row[x * 3..x * 3 + 3].fill(255);
                        }
                    }
                });
        } else {
            background
                .data_mut()
                .par_chunks_mut(gray.width())
                .enumerate()
                .for_each(|(y, row)| {
                    for (x, target) in row.iter_mut().enumerate() {
                        if binary.get(x, y) {
                            *target = 255;
                        }
                    }
                });
        }
        fill_picture_stencil_knockouts(
            &mut background,
            color_background.as_mut(),
            binary,
            &protected_picture_mask,
            dpi,
        );
        MixedLayers {
            foreground_mask,
            foreground_alpha: None,
            background,
            color_background,
            source_mrc: false,
        }
    });
    (mixed_gray, mixed_color, layers)
}

#[cfg(test)]
#[path = "final_composition_tests.rs"]
mod tests;
