use serde::{Deserialize, Serialize};

pub const MAX_BOOKMARK_ITEMS: usize = 5_000;
pub const MAX_BOOKMARK_DEPTH: usize = 64;
pub const MAX_PAGE_LABEL_RANGES: usize = 2_048;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageLabelRange {
    pub start_page: u32,
    pub style: Option<String>,
    pub prefix: String,
    pub start_number: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookmarkEntry {
    pub title: String,
    pub page_index: Option<u32>,
    pub page_y_ratio: Option<f64>,
    pub named_dest: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    pub color: Option<String>,
    #[serde(default)]
    pub items: Vec<BookmarkEntry>,
}

pub fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

pub fn normalize_page_label_style(style: Option<&str>) -> Option<String> {
    match style {
        Some("D" | "R" | "r" | "A" | "a") => style.map(ToOwned::to_owned),
        Some(_) => Some("D".to_string()),
        None => None,
    }
}

pub fn normalize_page_label_ranges(
    ranges: &[PageLabelRange],
    total_pages: u32,
) -> Vec<PageLabelRange> {
    if total_pages == 0 {
        return Vec::new();
    }

    let mut deduped = std::collections::BTreeMap::new();
    for range in ranges {
        let start_page = clamp_u32(range.start_page.max(1), 1, total_pages);
        deduped.insert(
            start_page,
            PageLabelRange {
                start_page,
                style: normalize_page_label_style(range.style.as_deref()),
                prefix: range.prefix.clone(),
                start_number: range.start_number.max(1),
            },
        );
    }
    deduped.entry(1).or_insert_with(|| PageLabelRange {
        start_page: 1,
        style: Some("D".to_string()),
        prefix: String::new(),
        start_number: 1,
    });
    deduped.into_values().collect()
}

pub fn is_implicit_default_page_labels(ranges: &[PageLabelRange], total_pages: u32) -> bool {
    let normalized = normalize_page_label_ranges(ranges, total_pages);
    normalized.len() == 1
        && normalized[0].start_page == 1
        && normalized[0].style.as_deref() == Some("D")
        && normalized[0].prefix.is_empty()
        && normalized[0].start_number == 1
}

pub fn normalize_bookmark_color(color: Option<&str>) -> Option<String> {
    parse_pdf_color(color).map(|rgb| {
        let to_byte = |value: f64| -> u8 { (value.clamp(0.0, 1.0) * 255.0).round() as u8 };
        format!(
            "#{:02x}{:02x}{:02x}",
            to_byte(rgb[0]),
            to_byte(rgb[1]),
            to_byte(rgb[2])
        )
    })
}

pub fn normalize_bookmark_entries(
    items: &[BookmarkEntry],
    total_pages: u32,
    untitled_label: &str,
) -> Vec<BookmarkEntry> {
    if total_pages == 0 {
        return Vec::new();
    }
    let max_page_index = total_pages - 1;
    items
        .iter()
        .map(|item| {
            let title = item.title.trim();
            let named_dest = item
                .named_dest
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            BookmarkEntry {
                title: if title.is_empty() {
                    untitled_label.to_string()
                } else {
                    title.to_string()
                },
                page_index: item
                    .page_index
                    .map(|page_index| page_index.min(max_page_index)),
                page_y_ratio: item
                    .page_y_ratio
                    .filter(|value| value.is_finite())
                    .map(|value| value.clamp(0.0, 1.0)),
                named_dest,
                bold: item.bold,
                italic: item.italic,
                color: normalize_bookmark_color(item.color.as_deref()),
                items: normalize_bookmark_entries(&item.items, total_pages, untitled_label),
            }
        })
        .collect()
}

pub fn resolve_bookmark_destination_top(page_height: f64, page_y_ratio: Option<f64>) -> f64 {
    let Some(page_y_ratio) = page_y_ratio else {
        return page_height;
    };
    page_height - page_y_ratio.clamp(0.0, 1.0) * page_height.max(0.0)
}

fn parse_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parse_hex_color_component(high: u8, low: u8) -> Option<f64> {
    Some(f64::from(parse_hex_digit(high)? * 16 + parse_hex_digit(low)?) / 255.0)
}

fn parse_rgb_number(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.clamp(0.0, 255.0) / 255.0)
}

fn parse_pdf_color(color: Option<&str>) -> Option<[f64; 3]> {
    let trimmed = color?.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("transparent")
        || trimmed.eq_ignore_ascii_case("none")
    {
        return None;
    }

    if let Some(hex) = trimmed.strip_prefix('#') {
        let bytes = hex.as_bytes();
        if bytes.len() == 3 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[0])?,
                parse_hex_color_component(bytes[1], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[2])?,
            ]);
        }
        if bytes.len() == 6 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[3])?,
                parse_hex_color_component(bytes[4], bytes[5])?,
            ]);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    let args = lower
        .strip_prefix("rgb(")
        .and_then(|value| value.strip_suffix(')'))
        .or_else(|| {
            lower
                .strip_prefix("rgba(")
                .and_then(|value| value.strip_suffix(')'))
        })?;
    let mut parts = args.split(',');
    Some([
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_page_label_ranges_by_page_and_adds_default() {
        let ranges = normalize_page_label_ranges(
            &[
                PageLabelRange {
                    start_page: 0,
                    style: Some("invalid".to_string()),
                    prefix: "front-".to_string(),
                    start_number: 0,
                },
                PageLabelRange {
                    start_page: 99,
                    style: Some("r".to_string()),
                    prefix: "back-".to_string(),
                    start_number: 3,
                },
            ],
            4,
        );

        assert_eq!(ranges[0].start_page, 1);
        assert_eq!(ranges[0].style.as_deref(), Some("D"));
        assert_eq!(ranges[0].start_number, 1);
        assert_eq!(ranges[1].start_page, 4);
    }

    #[test]
    fn normalizes_bookmark_text_and_color() {
        let normalized = normalize_bookmark_entries(
            &[BookmarkEntry {
                title: "  Chapter 1  ".to_string(),
                page_index: Some(99),
                page_y_ratio: Some(f64::NAN),
                named_dest: Some("  ".to_string()),
                bold: true,
                italic: false,
                color: Some("#abc".to_string()),
                items: Vec::new(),
            }],
            2,
            "Untitled",
        );

        assert_eq!(normalized[0].title, "Chapter 1");
        assert_eq!(normalized[0].page_index, Some(1));
        assert_eq!(normalized[0].page_y_ratio, None);
        assert_eq!(normalized[0].named_dest, None);
        assert_eq!(normalized[0].color.as_deref(), Some("#aabbcc"));
    }
}
