use lopdf::{Document, Object, ObjectId};
use std::{collections::HashSet, env, error::Error, fs, path::PathBuf};

const VERSION: &str = env!("CARGO_PKG_VERSION");

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Clone, Copy)]
struct CropMargins {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

#[derive(Clone, Copy)]
struct PdfRect {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
}

impl PdfRect {
    fn width(self) -> f64 {
        self.x2 - self.x1
    }

    fn height(self) -> f64 {
        self.y2 - self.y1
    }
}

enum Operation {
    Crop(CropMargins),
    RemoveCrop,
}

struct Config {
    operation: Operation,
    input_path: PathBuf,
    output_path: PathBuf,
    pages_file: PathBuf,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    if env::args().skip(1).any(|arg| arg == "--version") {
        println!("evb-pdf-page-ops {VERSION}");
        return Ok(());
    }

    let config = parse_args()?;
    let pages = read_pages_file(&config.pages_file)?;
    mutate_pdf(config, &pages)
}

fn parse_args() -> Result<Config> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("Missing command")?;
    let mut input_path = None;
    let mut output_path = None;
    let mut pages_file = None;
    let mut top = None;
    let mut bottom = None;
    let mut left = None;
    let mut right = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => {
                input_path = Some(PathBuf::from(args.next().ok_or("Missing --input value")?))
            }
            "--output" => {
                output_path = Some(PathBuf::from(args.next().ok_or("Missing --output value")?))
            }
            "--pages-file" => {
                pages_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --pages-file value")?,
                ))
            }
            "--top" => {
                top = Some(parse_margin(
                    &args.next().ok_or("Missing --top value")?,
                    "top",
                )?)
            }
            "--bottom" => {
                bottom = Some(parse_margin(
                    &args.next().ok_or("Missing --bottom value")?,
                    "bottom",
                )?)
            }
            "--left" => {
                left = Some(parse_margin(
                    &args.next().ok_or("Missing --left value")?,
                    "left",
                )?)
            }
            "--right" => {
                right = Some(parse_margin(
                    &args.next().ok_or("Missing --right value")?,
                    "right",
                )?)
            }
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }

    let operation = match command.as_str() {
        "crop" => Operation::Crop(CropMargins {
            top: top.ok_or("Missing --top value")?,
            bottom: bottom.ok_or("Missing --bottom value")?,
            left: left.ok_or("Missing --left value")?,
            right: right.ok_or("Missing --right value")?,
        }),
        "remove-crop" => Operation::RemoveCrop,
        _ => return Err(format!("Unknown command: {command}").into()),
    };

    Ok(Config {
        operation,
        input_path: input_path.ok_or("Missing --input value")?,
        output_path: output_path.ok_or("Missing --output value")?,
        pages_file: pages_file.ok_or("Missing --pages-file value")?,
    })
}

fn parse_margin(value: &str, label: &str) -> Result<f64> {
    let parsed = value.parse::<f64>()?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!("Invalid {label} margin").into());
    }
    Ok(parsed)
}

fn read_pages_file(path: &PathBuf) -> Result<Vec<u32>> {
    let contents = fs::read_to_string(path)?;
    let mut pages = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let page = trimmed
            .parse::<u32>()
            .map_err(|_| format!("Invalid page number on line {}", index + 1))?;
        if page == 0 {
            return Err(format!("Invalid page number on line {}", index + 1).into());
        }
        pages.push(page);
    }
    if pages.is_empty() {
        return Err("At least one page must be selected".into());
    }
    Ok(pages)
}

fn mutate_pdf(config: Config, pages: &[u32]) -> Result<()> {
    let mut document = Document::load(&config.input_path)?;
    if document.is_encrypted() {
        return Err("Encrypted PDFs are not supported by native page ops".into());
    }

    match config.operation {
        Operation::Crop(margins) => crop_pages(&mut document, pages, margins)?,
        Operation::RemoveCrop => remove_crop_from_pages(&mut document, pages)?,
    }

    document.save(&config.output_path)?;
    Ok(())
}

fn crop_pages(document: &mut Document, pages: &[u32], margins: CropMargins) -> Result<()> {
    let page_map = document.get_pages();
    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
        let crop_width = media_box.width() - margins.left - margins.right;
        let crop_height = media_box.height() - margins.top - margins.bottom;
        if crop_width <= 0.0 || crop_height <= 0.0 {
            continue;
        }

        let crop_box = PdfRect {
            x1: media_box.x1 + margins.left,
            y1: media_box.y1 + margins.bottom,
            x2: media_box.x1 + margins.left + crop_width,
            y2: media_box.y1 + margins.bottom + crop_height,
        };
        set_page_crop_box(document, page_id, crop_box)?;
    }
    Ok(())
}

fn remove_crop_from_pages(document: &mut Document, pages: &[u32]) -> Result<()> {
    let page_map = document.get_pages();
    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
        set_page_crop_box(document, page_id, media_box)?;
    }
    Ok(())
}

fn resolve_page_id(
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    page_number: u32,
) -> Result<ObjectId> {
    page_map.get(&page_number).copied().ok_or_else(|| {
        format!(
            "Page {page_number} is outside the document page range 1-{}",
            page_map.len()
        )
        .into()
    })
}

fn resolve_inherited_box(document: &Document, page_id: ObjectId, key: &[u8]) -> Result<PdfRect> {
    let mut current_id = Some(page_id);
    let mut seen = HashSet::new();

    while let Some(object_id) = current_id {
        if !seen.insert(object_id) {
            return Err(format!(
                "Page tree cycle while resolving {}",
                String::from_utf8_lossy(key)
            )
            .into());
        }

        let dict = document.get_dictionary(object_id)?;
        if let Ok(object) = dict.get(key) {
            let (_, resolved) = document.dereference(object)?;
            return parse_rect(resolved);
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into())
}

fn parse_rect(object: &Object) -> Result<PdfRect> {
    let values = object.as_array()?;
    if values.len() != 4 {
        return Err("PDF rectangle must contain 4 values".into());
    }

    let rect = PdfRect {
        x1: object_to_f64(&values[0])?,
        y1: object_to_f64(&values[1])?,
        x2: object_to_f64(&values[2])?,
        y2: object_to_f64(&values[3])?,
    };
    if !rect.width().is_finite()
        || !rect.height().is_finite()
        || rect.width() <= 0.0
        || rect.height() <= 0.0
    {
        return Err("Invalid PDF rectangle dimensions".into());
    }
    Ok(rect)
}

fn object_to_f64(object: &Object) -> Result<f64> {
    let value = object.as_float()? as f64;
    if !value.is_finite() {
        return Err("PDF rectangle contains a non-finite value".into());
    }
    Ok(value)
}

fn set_page_crop_box(document: &mut Document, page_id: ObjectId, rect: PdfRect) -> Result<()> {
    let page = document.get_dictionary_mut(page_id)?;
    page.set(
        "CropBox",
        Object::Array(vec![
            number_object(rect.x1),
            number_object(rect.y1),
            number_object(rect.x2),
            number_object(rect.y2),
        ]),
    );
    Ok(())
}

fn number_object(value: f64) -> Object {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001
        && rounded >= i64::MIN as f64
        && rounded <= i64::MAX as f64
    {
        Object::Integer(rounded as i64)
    } else {
        Object::Real(value as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Object};

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

    fn crop_box(document: &Document, page_id: ObjectId) -> Vec<f64> {
        document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap() as f64)
            .collect()
    }

    #[test]
    fn crops_pages_using_inherited_media_box() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        )
        .unwrap();

        assert_eq!(crop_box(&document, page_id), vec![2.0, 3.0, 199.0, 96.0]);
    }

    #[test]
    fn remove_crop_restores_media_box() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        )
        .unwrap();
        remove_crop_from_pages(&mut document, &[1]).unwrap();

        assert_eq!(crop_box(&document, page_id), vec![0.0, 0.0, 200.0, 100.0]);
    }

    #[test]
    fn skips_crop_when_margins_consume_page() {
        let (mut document, page_id) = create_test_document();

        crop_pages(
            &mut document,
            &[1],
            CropMargins {
                top: 100.0,
                bottom: 0.0,
                left: 0.0,
                right: 0.0,
            },
        )
        .unwrap();

        assert!(document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
    }
}
