use lopdf::{
    content::{Content, Operation},
    DecompressError, Dictionary, Document, Error as LopdfError, Object, ObjectId,
};
use serde::Serialize;
use std::{collections::HashMap, fs, path::Path};

use crate::{
    domain_error, reclassify_domain_error, resolve_page_rotation, resolve_page_view,
    NativeErrorCode, PdfRect, Result, MAX_DECOMPRESSED_PDF_STREAM_BYTES,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageSizesOutput {
    pages: Vec<PageSizeEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageSizeEntry {
    page_number: u32,
    x_points: f64,
    y_points: f64,
    width_points: f64,
    height_points: f64,
    width_inches: f64,
    height_inches: f64,
    rotation: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_width_px: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_height_px: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_width_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_height_points: Option<f64>,
}

#[derive(Clone, Copy)]
struct Matrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Matrix {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn concat(self, rhs: Self) -> Self {
        Self {
            a: self.a * rhs.a + self.c * rhs.b,
            b: self.b * rhs.a + self.d * rhs.b,
            c: self.a * rhs.c + self.c * rhs.d,
            d: self.b * rhs.c + self.d * rhs.d,
            e: self.a * rhs.e + self.c * rhs.f + self.e,
            f: self.b * rhs.e + self.d * rhs.f + self.f,
        }
    }

    fn transform(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }
}

#[derive(Clone, Copy, Debug)]
struct FullPageImage {
    width_px: i64,
    height_px: i64,
    width_points: f64,
    height_points: f64,
}

fn resolved_dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match object {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Reference(id) => document.get_dictionary(*id).ok(),
        _ => None,
    }
}

fn collect_image_dimensions(
    document: &Document,
    resources: &Dictionary,
    images: &mut HashMap<Vec<u8>, (i64, i64)>,
) {
    let Some(xobjects) = resources
        .get(b"XObject")
        .ok()
        .and_then(|object| resolved_dictionary(document, object))
    else {
        return;
    };
    for (name, object) in xobjects {
        let stream = match object {
            Object::Reference(id) => document.get_object(*id).and_then(Object::as_stream).ok(),
            Object::Stream(stream) => Some(stream),
            _ => None,
        };
        let Some(stream) = stream else {
            continue;
        };
        if stream.dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Image") {
            continue;
        }
        let width = stream.dict.get(b"Width").and_then(Object::as_i64).ok();
        let height = stream.dict.get(b"Height").and_then(Object::as_i64).ok();
        if let (Some(width), Some(height)) = (width, height) {
            if width > 0 && height > 0 {
                images.insert(name.clone(), (width, height));
            }
        }
    }
}

fn page_image_dimensions(
    document: &Document,
    page_id: ObjectId,
) -> Result<HashMap<Vec<u8>, (i64, i64)>> {
    let (direct_resources, resource_ids) = document.get_page_resources(page_id)?;
    let mut images = HashMap::new();
    // Inherited resources are the fallback; a nearer page resource with the
    // same name overrides them.
    for resource_id in resource_ids.into_iter().rev() {
        if let Ok(resources) = document.get_dictionary(resource_id) {
            collect_image_dimensions(document, resources, &mut images);
        }
    }
    if let Some(resources) = direct_resources {
        collect_image_dimensions(document, resources, &mut images);
    }
    Ok(images)
}

fn object_number(object: &Object) -> Option<f64> {
    object.as_float().ok().map(f64::from)
}

fn covers_page(matrix: Matrix, page_view: PdfRect) -> bool {
    let corners = [
        matrix.transform(0.0, 0.0),
        matrix.transform(1.0, 0.0),
        matrix.transform(0.0, 1.0),
        matrix.transform(1.0, 1.0),
    ];
    let min_x = corners
        .iter()
        .map(|(x, _)| *x)
        .fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|(x, _)| *x)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = corners
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::INFINITY, f64::min);
    let max_y = corners
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::NEG_INFINITY, f64::max);
    let overlap_width = (max_x.min(page_view.x2) - min_x.max(page_view.x1)).max(0.0);
    let overlap_height = (max_y.min(page_view.y2) - min_y.max(page_view.y1)).max(0.0);
    overlap_width >= page_view.width() * 0.98 && overlap_height >= page_view.height() * 0.98
}

fn decode_page_content_with_limit(
    document: &Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
) -> Result<Content<Vec<Operation>>> {
    let bytes = document
        .get_page_content_with_limit(page_id, max_decompressed_bytes)
        .map_err(|error| {
            if matches!(
                error,
                LopdfError::Decompress(DecompressError::MemoryLimitExceeded { .. })
            ) {
                domain_error(
                    NativeErrorCode::TooLarge,
                    format!(
                        "PDF page content exceeds the {max_decompressed_bytes}-byte decompression ceiling"
                    ),
                )
            } else {
                domain_error(
                    NativeErrorCode::CorruptXref,
                    format!("Failed to decode PDF page content: {error}"),
                )
            }
        })?;
    Content::decode(&bytes).map_err(|error| {
        domain_error(
            NativeErrorCode::CorruptXref,
            format!("Failed to parse PDF page content: {error}"),
        )
    })
}

fn dominant_full_page_image_with_limit(
    document: &Document,
    page_id: ObjectId,
    page_view: PdfRect,
    max_decompressed_bytes: usize,
) -> Result<Option<FullPageImage>> {
    let images = page_image_dimensions(document, page_id)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref))?;
    if images.is_empty() {
        return Ok(None);
    }
    let content = decode_page_content_with_limit(document, page_id, max_decompressed_bytes)?;
    let mut matrix = Matrix::IDENTITY;
    let mut stack = Vec::new();
    let mut dominant: Option<FullPageImage> = None;

    for operation in content.operations {
        match operation.operator.as_str() {
            "q" => stack.push(matrix),
            "Q" => matrix = stack.pop().unwrap_or(Matrix::IDENTITY),
            "cm" if operation.operands.len() == 6 => {
                let values = operation
                    .operands
                    .iter()
                    .map(object_number)
                    .collect::<Option<Vec<_>>>();
                if let Some(values) = values {
                    matrix = matrix.concat(Matrix {
                        a: values[0],
                        b: values[1],
                        c: values[2],
                        d: values[3],
                        e: values[4],
                        f: values[5],
                    });
                }
            }
            "Do" if operation.operands.len() == 1 && covers_page(matrix, page_view) => {
                let Ok(name) = operation.operands[0].as_name() else {
                    continue;
                };
                let Some(&(width_px, height_px)) = images.get(name) else {
                    continue;
                };
                let candidate = FullPageImage {
                    width_px,
                    height_px,
                    width_points: matrix.a.hypot(matrix.b),
                    height_points: matrix.c.hypot(matrix.d),
                };
                if candidate.width_points <= 0.0 || candidate.height_points <= 0.0 {
                    continue;
                }
                let candidate_area = candidate.width_px.saturating_mul(candidate.height_px);
                let dominant_area = dominant
                    .map(|image| image.width_px.saturating_mul(image.height_px))
                    .unwrap_or(0);
                if candidate_area > dominant_area {
                    dominant = Some(candidate);
                }
            }
            _ => {}
        }
    }
    Ok(dominant)
}

fn dominant_full_page_image(
    document: &Document,
    page_id: ObjectId,
    page_view: PdfRect,
) -> Result<Option<FullPageImage>> {
    dominant_full_page_image_with_limit(
        document,
        page_id,
        page_view,
        MAX_DECOMPRESSED_PDF_STREAM_BYTES,
    )
}

fn collect_page_sizes(document: &Document) -> Result<PageSizesOutput> {
    let pages = document
        .get_pages()
        .into_iter()
        .map(|(page_number, page_id)| {
            let page_view = resolve_page_view(document, page_id)?;
            let rotation = resolve_page_rotation(document, page_id)?;
            let dominant_image = dominant_full_page_image(document, page_id, page_view)?;
            Ok(PageSizeEntry {
                page_number,
                x_points: page_view.x1,
                y_points: page_view.y1,
                width_points: page_view.width(),
                height_points: page_view.height(),
                width_inches: page_view.width() / 72.0,
                height_inches: page_view.height() / 72.0,
                rotation,
                dominant_image_width_px: dominant_image.map(|image| image.width_px),
                dominant_image_height_px: dominant_image.map(|image| image.height_px),
                dominant_image_width_points: dominant_image.map(|image| image.width_points),
                dominant_image_height_points: dominant_image.map(|image| image.height_points),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(PageSizesOutput { pages })
}

pub(crate) fn write_page_sizes_json(document: &Document, output_path: &Path) -> Result<()> {
    let page_sizes = collect_page_sizes(document)?;
    fs::write(output_path, serde_json::to_vec(&page_sizes)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn create_test_document() -> (Document, ObjectId) {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id)
    }

    #[test]
    fn collects_page_sizes_from_inherited_boxes() {
        let (mut document, page_id) = create_test_document();
        document.get_dictionary_mut(page_id).unwrap().set(
            "CropBox",
            vec![10.into(), 20.into(), 190.into(), 100.into()],
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Rotate", 90);

        let output = collect_page_sizes(&document).unwrap();

        assert_eq!(output.pages.len(), 1);
        assert_eq!(output.pages[0].page_number, 1);
        assert_eq!(output.pages[0].x_points, 10.0);
        assert_eq!(output.pages[0].y_points, 20.0);
        assert_eq!(output.pages[0].width_points, 180.0);
        assert_eq!(output.pages[0].height_points, 80.0);
        assert_eq!(output.pages[0].width_inches, 2.5);
        assert!((output.pages[0].height_inches - (80.0 / 72.0)).abs() < 0.000_001);
        assert_eq!(output.pages[0].rotation, 90);
    }

    #[test]
    fn reports_a_raster_that_covers_the_page() {
        let (mut document, page_id) = create_test_document();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1000,
                "Height" => 500,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            Vec::new(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 200 0 0 100 0 0 cm /Scan Do Q".to_vec(),
        ));
        document.get_dictionary_mut(page_id).unwrap().set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {
                    "Scan" => image_id,
                },
            },
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", content_id);

        let output = collect_page_sizes(&document).unwrap();
        let page = &output.pages[0];

        assert_eq!(page.dominant_image_width_px, Some(1000));
        assert_eq!(page.dominant_image_height_px, Some(500));
        assert_eq!(page.dominant_image_width_points, Some(200.0));
        assert_eq!(page.dominant_image_height_points, Some(100.0));
    }

    #[test]
    fn ignores_a_raster_that_does_not_cover_the_page() {
        let (mut document, page_id) = create_test_document();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1000,
                "Height" => 500,
            },
            Vec::new(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 100 0 0 50 0 0 cm /Thumbnail Do Q".to_vec(),
        ));
        document.get_dictionary_mut(page_id).unwrap().set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {
                    "Thumbnail" => image_id,
                },
            },
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", content_id);

        let output = collect_page_sizes(&document).unwrap();
        let page = &output.pages[0];

        assert_eq!(page.dominant_image_width_px, None);
        assert_eq!(page.dominant_image_height_px, None);
    }

    #[test]
    fn rejects_expanding_page_content_during_page_size_inspection() {
        let (mut document, page_id) = create_test_document();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
            },
            Vec::new(),
        ));
        let mut content = Stream::new(Dictionary::new(), vec![b' '; 1_024]);
        content.compress().unwrap();
        let content_id = document.add_object(content);
        document.get_dictionary_mut(page_id).unwrap().set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {
                    "Scan" => image_id,
                },
            },
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", content_id);
        let page_view = resolve_page_view(&document, page_id).unwrap();

        let error =
            dominant_full_page_image_with_limit(&document, page_id, page_view, 32).unwrap_err();
        let native_error = error.downcast_ref::<crate::NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error
            .message
            .contains("32-byte decompression ceiling"));
    }
}
