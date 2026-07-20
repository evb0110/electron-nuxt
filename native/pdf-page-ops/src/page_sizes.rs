use lopdf::Document;
use serde::Serialize;
use std::{fs, path::Path};

use crate::{resolve_page_rotation, resolve_page_view, Result};

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
}

fn collect_page_sizes(document: &Document) -> Result<PageSizesOutput> {
    let pages = document
        .get_pages()
        .into_iter()
        .map(|(page_number, page_id)| {
            let page_view = resolve_page_view(document, page_id)?;
            let rotation = resolve_page_rotation(document, page_id)?;
            Ok(PageSizeEntry {
                page_number,
                x_points: page_view.x1,
                y_points: page_view.y1,
                width_points: page_view.width(),
                height_points: page_view.height(),
                width_inches: page_view.width() / 72.0,
                height_inches: page_view.height() / 72.0,
                rotation,
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
    use lopdf::{dictionary, Object, ObjectId};

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
}
