use serde::Serialize;
use std::env;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::process;
use unicode_casefold::{Locale, UnicodeCaseFold, Variant};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAGIC: &[u8; 8] = b"EVBSIDX1";
const SCHEMA_VERSION: u32 = 1;
const HEADER_SIZE: usize = 24;
const PAGE_RECORD_SIZE: usize = 24;

#[derive(Debug)]
struct CliError(String);

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for CliError {}

#[derive(Debug, Clone)]
struct PageRecord {
    page_number: u32,
    offset: usize,
    byte_len: usize,
}

#[derive(Debug)]
struct SearchIndex {
    page_count: u32,
    records: Vec<PageRecord>,
    data: Vec<u8>,
}

#[derive(Debug)]
struct SearchOptions {
    index_path: PathBuf,
    query: String,
    limit: usize,
    context_chars: usize,
    match_case: bool,
    page_count: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct SearchExcerpt {
    prefix: bool,
    suffix: bool,
    before: String,
    #[serde(rename = "match")]
    matched_text: String,
    after: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct SearchMatch {
    #[serde(rename = "pageNumber")]
    page_number: u32,
    #[serde(rename = "pageMatchIndex")]
    page_match_index: usize,
    #[serde(rename = "matchIndex")]
    match_index: usize,
    #[serde(rename = "startOffset")]
    start_offset: usize,
    #[serde(rename = "endOffset")]
    end_offset: usize,
    excerpt: SearchExcerpt,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct SearchResponse {
    results: Vec<SearchMatch>,
    truncated: bool,
    #[serde(rename = "pageCount")]
    page_count: u32,
}

fn usage() -> &'static str {
    "Usage: evb-pdf-search search --index <path> --query <text> [--limit <n>] [--context <n>] [--match-case] [--page-count <n>]"
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, CliError> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| CliError("Native search index offset overflow".to_string()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| CliError("Native search index ended unexpectedly".to_string()))?;
    let array: [u8; 4] = slice
        .try_into()
        .map_err(|_| CliError("Invalid native search index u32 field".to_string()))?;
    Ok(u32::from_le_bytes(array))
}

fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64, CliError> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| CliError("Native search index offset overflow".to_string()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| CliError("Native search index ended unexpectedly".to_string()))?;
    let array: [u8; 8] = slice
        .try_into()
        .map_err(|_| CliError("Invalid native search index u64 field".to_string()))?;
    Ok(u64::from_le_bytes(array))
}

fn usize_from_u64(value: u64, label: &str) -> Result<usize, CliError> {
    usize::try_from(value).map_err(|_| {
        CliError(format!(
            "Native search index {label} does not fit this platform"
        ))
    })
}

fn load_index(path: &PathBuf) -> Result<SearchIndex, Box<dyn Error>> {
    let data = fs::read(path)?;
    if data.len() < HEADER_SIZE {
        return Err(Box::new(CliError(
            "Native search index is too small".to_string(),
        )));
    }
    if data.get(0..8) != Some(&MAGIC[..]) {
        return Err(Box::new(CliError(
            "Native search index magic mismatch".to_string(),
        )));
    }

    let schema_version = read_u32_le(&data, 8)?;
    if schema_version != SCHEMA_VERSION {
        return Err(Box::new(CliError(format!(
            "Unsupported native search index schema version {schema_version}",
        ))));
    }

    let page_count = read_u32_le(&data, 12)?;
    let page_record_count = read_u32_le(&data, 16)?;
    let page_record_count_usize = usize::try_from(page_record_count)
        .map_err(|_| CliError("Native search index page count is too large".to_string()))?;
    let table_size = page_record_count_usize
        .checked_mul(PAGE_RECORD_SIZE)
        .ok_or_else(|| CliError("Native search index table is too large".to_string()))?;
    let minimum_size = HEADER_SIZE
        .checked_add(table_size)
        .ok_or_else(|| CliError("Native search index table offset overflow".to_string()))?;
    if data.len() < minimum_size {
        return Err(Box::new(CliError(
            "Native search index page table is truncated".to_string(),
        )));
    }

    let mut records = Vec::with_capacity(page_record_count_usize);
    for record_index in 0..page_record_count_usize {
        let record_offset = HEADER_SIZE + record_index * PAGE_RECORD_SIZE;
        let page_number = read_u32_le(&data, record_offset)?;
        let byte_offset = usize_from_u64(read_u64_le(&data, record_offset + 8)?, "byte offset")?;
        let byte_len = usize_from_u64(read_u64_le(&data, record_offset + 16)?, "byte length")?;
        let byte_end = byte_offset
            .checked_add(byte_len)
            .ok_or_else(|| CliError("Native search index page text offset overflow".to_string()))?;
        if byte_end > data.len() {
            return Err(Box::new(CliError(
                "Native search index page text is truncated".to_string(),
            )));
        }
        records.push(PageRecord {
            page_number,
            offset: byte_offset,
            byte_len,
        });
    }

    Ok(SearchIndex {
        page_count,
        records,
        data,
    })
}

impl SearchIndex {
    fn page_text(&self, record: &PageRecord) -> Result<&str, Box<dyn Error>> {
        let end = record
            .offset
            .checked_add(record.byte_len)
            .ok_or_else(|| CliError("Native search index page text offset overflow".to_string()))?;
        Ok(std::str::from_utf8(&self.data[record.offset..end])?)
    }
}

fn parse_usize(value: Option<String>, label: &str) -> Result<usize, Box<dyn Error>> {
    let raw = value.ok_or_else(|| CliError(format!("Missing value for {label}")))?;
    let parsed = raw
        .parse::<usize>()
        .map_err(|_| CliError(format!("Invalid numeric value for {label}: {raw}")))?;
    Ok(parsed)
}

fn parse_u32(value: Option<String>, label: &str) -> Result<u32, Box<dyn Error>> {
    let raw = value.ok_or_else(|| CliError(format!("Missing value for {label}")))?;
    let parsed = raw
        .parse::<u32>()
        .map_err(|_| CliError(format!("Invalid numeric value for {label}: {raw}")))?;
    Ok(parsed)
}

fn parse_search_options(
    mut args: impl Iterator<Item = String>,
) -> Result<SearchOptions, Box<dyn Error>> {
    let mut index_path: Option<PathBuf> = None;
    let mut query: Option<String> = None;
    let mut limit = 500usize;
    let mut context_chars = 32usize;
    let mut match_case = false;
    let mut page_count: Option<u32> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--index" => {
                index_path =
                    Some(PathBuf::from(args.next().ok_or_else(|| {
                        CliError("Missing value for --index".to_string())
                    })?));
            }
            "--query" => {
                query = Some(
                    args.next()
                        .ok_or_else(|| CliError("Missing value for --query".to_string()))?,
                );
            }
            "--limit" => {
                limit = parse_usize(args.next(), "--limit")?;
            }
            "--context" => {
                context_chars = parse_usize(args.next(), "--context")?;
            }
            "--match-case" => {
                match_case = true;
            }
            "--page-count" => {
                page_count = Some(parse_u32(args.next(), "--page-count")?);
            }
            "--help" | "-h" => {
                return Err(Box::new(CliError(usage().to_string())));
            }
            _ => {
                return Err(Box::new(CliError(format!(
                    "Unknown search argument: {arg}"
                ))));
            }
        }
    }

    let query = query.ok_or_else(|| CliError("Missing required --query".to_string()))?;
    if query.is_empty() {
        return Err(Box::new(CliError(
            "Search query must not be empty".to_string(),
        )));
    }

    Ok(SearchOptions {
        index_path: index_path.ok_or_else(|| CliError("Missing required --index".to_string()))?,
        query,
        limit,
        context_chars,
        match_case,
        page_count,
    })
}

fn find_case_sensitive_matches(text: &str, needle: &str) -> Vec<(usize, usize)> {
    if needle.is_empty() {
        return Vec::new();
    }

    let mut matches = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative_start) = text[cursor..].find(needle) {
        let start = cursor + relative_start;
        let end = start + needle.len();
        if text.is_char_boundary(start) && text.is_char_boundary(end) {
            matches.push((start, end));
        }
        cursor = end;
        if cursor >= text.len() {
            break;
        }
    }
    matches
}

fn ascii_bytes_equal_ignore_case(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left_byte, right_byte)| left_byte.eq_ignore_ascii_case(right_byte))
}

fn find_ascii_case_insensitive_matches(text: &str, needle: &str) -> Vec<(usize, usize)> {
    let needle_bytes = needle.as_bytes();
    if needle_bytes.is_empty() || !needle.is_ascii() {
        return Vec::new();
    }

    let haystack = text.as_bytes();
    let needle_len = needle_bytes.len();
    let mut matches = Vec::new();
    let mut cursor = 0usize;
    while cursor + needle_len <= haystack.len() {
        let end = cursor + needle_len;
        if ascii_bytes_equal_ignore_case(&haystack[cursor..end], needle_bytes)
            && text.is_char_boundary(cursor)
            && text.is_char_boundary(end)
        {
            matches.push((cursor, end));
            cursor = end;
            continue;
        }
        cursor += 1;
    }
    matches
}

#[derive(Debug, PartialEq, Eq)]
struct FoldedCharSpan {
    folded_start: usize,
    folded_end: usize,
    original_start: usize,
    original_end: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct FoldedText {
    text: String,
    spans: Vec<FoldedCharSpan>,
}

fn simple_case_fold(value: &str) -> String {
    value
        .case_fold_with(Variant::Simple, Locale::NonTurkic)
        .collect()
}

fn fold_text_with_spans(value: &str) -> FoldedText {
    let mut text = String::with_capacity(value.len());
    let mut spans = Vec::with_capacity(value.chars().count());

    for (original_start, character) in value.char_indices() {
        let original_end = original_start + character.len_utf8();
        let folded_start = text.len();
        for folded_character in character.case_fold_with(Variant::Simple, Locale::NonTurkic) {
            text.push(folded_character);
        }
        spans.push(FoldedCharSpan {
            folded_start,
            folded_end: text.len(),
            original_start,
            original_end,
        });
    }

    FoldedText { text, spans }
}

fn original_byte_range_for_folded_match(
    folded: &FoldedText,
    folded_start: usize,
    folded_end: usize,
) -> Option<(usize, usize)> {
    let start_span_index = folded
        .spans
        .binary_search_by_key(&folded_start, |span| span.folded_start)
        .ok()?;
    let end_span_index = folded
        .spans
        .binary_search_by_key(&folded_end, |span| span.folded_end)
        .ok()?;
    Some((
        folded.spans[start_span_index].original_start,
        folded.spans[end_span_index].original_end,
    ))
}

fn find_unicode_case_insensitive_matches(text: &str, needle: &str) -> Vec<(usize, usize)> {
    let folded_needle = simple_case_fold(needle);
    if folded_needle.is_empty() {
        return Vec::new();
    }

    let folded_text = fold_text_with_spans(text);
    find_case_sensitive_matches(&folded_text.text, &folded_needle)
        .into_iter()
        .filter_map(|(start, end)| original_byte_range_for_folded_match(&folded_text, start, end))
        .collect()
}

fn find_matches(text: &str, needle: &str, match_case: bool) -> Vec<(usize, usize)> {
    if match_case {
        find_case_sensitive_matches(text, needle)
    } else if text.is_ascii() && needle.is_ascii() {
        find_ascii_case_insensitive_matches(text, needle)
    } else {
        find_unicode_case_insensitive_matches(text, needle)
    }
}

fn utf16_offset_for_byte(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].encode_utf16().count()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn byte_index_for_utf16_offset(text: &str, target_offset: usize) -> usize {
    let mut utf16_offset = 0usize;
    for (byte_index, character) in text.char_indices() {
        let next_offset = utf16_offset + character.len_utf16();
        if next_offset > target_offset {
            return byte_index;
        }
        if next_offset == target_offset {
            return byte_index + character.len_utf8();
        }
        utf16_offset = next_offset;
    }
    text.len()
}

fn collapse_whitespace(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_whitespace = false;
    for character in value.chars() {
        if character.is_whitespace() {
            if !in_whitespace {
                collapsed.push(' ');
                in_whitespace = true;
            }
            continue;
        }
        collapsed.push(character);
        in_whitespace = false;
    }
    collapsed
}

fn build_excerpt(
    text: &str,
    start_byte_offset: usize,
    end_byte_offset: usize,
    start_utf16_offset: usize,
    end_utf16_offset: usize,
    context_chars: usize,
) -> SearchExcerpt {
    let text_utf16_len = utf16_len(text);
    let excerpt_start_utf16 = start_utf16_offset.saturating_sub(context_chars);
    let excerpt_end_utf16 = text_utf16_len.min(end_utf16_offset.saturating_add(context_chars));
    let excerpt_start_byte = byte_index_for_utf16_offset(text, excerpt_start_utf16);
    let excerpt_end_byte = byte_index_for_utf16_offset(text, excerpt_end_utf16);

    let before = collapse_whitespace(&text[excerpt_start_byte..start_byte_offset])
        .trim_start()
        .to_string();
    let after = collapse_whitespace(&text[end_byte_offset..excerpt_end_byte])
        .trim_end()
        .to_string();

    SearchExcerpt {
        prefix: excerpt_start_utf16 > 0,
        suffix: excerpt_end_utf16 < text_utf16_len,
        before,
        matched_text: text[start_byte_offset..end_byte_offset].to_string(),
        after,
    }
}

fn search_index(
    index: &SearchIndex,
    options: &SearchOptions,
) -> Result<SearchResponse, Box<dyn Error>> {
    let total_pages = options.page_count.unwrap_or(index.page_count);
    let mut results = Vec::new();
    let mut truncated = false;

    'pages: for record in &index.records {
        if record.page_number == 0 || record.page_number > total_pages {
            continue;
        }

        let text = index.page_text(record)?;
        let mut page_match_index = 0usize;
        for (start_byte, end_byte) in find_matches(text, &options.query, options.match_case) {
            let start_offset = utf16_offset_for_byte(text, start_byte);
            let end_offset = utf16_offset_for_byte(text, end_byte);
            results.push(SearchMatch {
                page_number: record.page_number,
                page_match_index,
                match_index: results.len(),
                start_offset,
                end_offset,
                excerpt: build_excerpt(
                    text,
                    start_byte,
                    end_byte,
                    start_offset,
                    end_offset,
                    options.context_chars,
                ),
            });
            page_match_index += 1;

            if results.len() >= options.limit {
                truncated = true;
                break 'pages;
            }
        }
    }

    Ok(SearchResponse {
        results,
        truncated,
        page_count: total_pages,
    })
}

fn run_cli(mut args: impl Iterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let Some(command) = args.next() else {
        return Err(Box::new(CliError(usage().to_string())));
    };

    match command.as_str() {
        "--version" | "-V" => {
            println!("evb-pdf-search {VERSION}");
            Ok(())
        }
        "search" => {
            let options = parse_search_options(args)?;
            let index = load_index(&options.index_path)?;
            let response = search_index(&index, &options)?;
            println!("{}", serde_json::to_string(&response)?);
            Ok(())
        }
        "--help" | "-h" => Err(Box::new(CliError(usage().to_string()))),
        _ => Err(Box::new(CliError(format!("Unknown command: {command}")))),
    }
}

fn main() {
    if let Err(error) = run_cli(env::args().skip(1)) {
        eprintln!("{error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_index(pages: &[(u32, &str)]) -> SearchIndex {
        let mut data = Vec::new();
        let mut records = Vec::new();
        for (page_number, text) in pages {
            let offset = data.len();
            data.extend_from_slice(text.as_bytes());
            records.push(PageRecord {
                page_number: *page_number,
                offset,
                byte_len: text.len(),
            });
        }
        SearchIndex {
            page_count: pages.len() as u32,
            records,
            data,
        }
    }

    fn serialized_index(pages: &[(u32, &str)]) -> Vec<u8> {
        let header_size = HEADER_SIZE;
        let table_size = pages.len() * PAGE_RECORD_SIZE;
        let mut text_offset = header_size + table_size;
        let mut page_text = Vec::new();
        let mut records = Vec::new();

        for (page_number, text) in pages {
            let bytes = text.as_bytes();
            records.push((*page_number, text_offset, bytes.len()));
            page_text.extend_from_slice(bytes);
            text_offset += bytes.len();
        }

        let mut data = Vec::with_capacity(header_size + table_size + page_text.len());
        data.extend_from_slice(MAGIC);
        data.extend_from_slice(&SCHEMA_VERSION.to_le_bytes());
        data.extend_from_slice(&(pages.len() as u32).to_le_bytes());
        data.extend_from_slice(&(pages.len() as u32).to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());

        for (page_number, offset, byte_len) in records {
            data.extend_from_slice(&page_number.to_le_bytes());
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&(offset as u64).to_le_bytes());
            data.extend_from_slice(&(byte_len as u64).to_le_bytes());
        }

        data.extend_from_slice(&page_text);
        data
    }

    fn options(query: &str) -> SearchOptions {
        SearchOptions {
            index_path: PathBuf::new(),
            query: query.to_string(),
            limit: 500,
            context_chars: 8,
            match_case: false,
            page_count: None,
        }
    }

    #[test]
    fn loads_native_index_file_and_emits_stable_json_response() {
        let path = env::temp_dir().join(format!("evb-pdf-search-golden-{}", process::id()));
        fs::write(
            &path,
            serialized_index(&[
                (1, "one Alpha two"),
                (2, "zero alpha one alpha"),
                (3, "hidden alpha"),
            ]),
        )
        .expect("write temp native search index");

        let index = load_index(&path).expect("load native search index");
        fs::remove_file(&path).ok();

        let mut search_options = options("alpha");
        search_options.context_chars = 4;
        search_options.page_count = Some(2);
        let response = search_index(&index, &search_options).expect("search should succeed");

        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            concat!(
                r#"{"results":["#,
                r#"{"pageNumber":1,"pageMatchIndex":0,"matchIndex":0,"startOffset":4,"endOffset":9,"#,
                r#""excerpt":{"prefix":false,"suffix":false,"before":"one ","match":"Alpha","after":" two"}}"#,
                r#",{"pageNumber":2,"pageMatchIndex":0,"matchIndex":1,"startOffset":5,"endOffset":10,"#,
                r#""excerpt":{"prefix":true,"suffix":true,"before":"ero ","match":"alpha","after":" one"}}"#,
                r#",{"pageNumber":2,"pageMatchIndex":1,"matchIndex":2,"startOffset":15,"endOffset":20,"#,
                r#""excerpt":{"prefix":true,"suffix":false,"before":"one ","match":"alpha","after":""}}"#,
                r#"],"truncated":false,"pageCount":2}"#,
            ),
        );
    }

    #[test]
    fn searches_ascii_case_insensitive_literals() {
        let index = test_index(&[(1, "Alpha beta alpha"), (2, "ALPHA")]);

        let response = search_index(&index, &options("alpha")).expect("search should succeed");

        assert_eq!(response.results.len(), 3);
        assert_eq!(response.results[0].page_number, 1);
        assert_eq!(response.results[0].page_match_index, 0);
        assert_eq!(response.results[0].start_offset, 0);
        assert_eq!(response.results[1].page_match_index, 1);
        assert_eq!(response.results[2].page_number, 2);
        assert_eq!(response.results[2].matched_text(), "ALPHA");
    }

    #[test]
    fn searches_unicode_case_insensitive_literals() {
        let index = test_index(&[(1, "Привет, ЁЖ"), (2, "CAFÉ Σίσυφος K ſ")]);

        let cyrillic_response =
            search_index(&index, &options("ёж")).expect("search should succeed");
        assert_eq!(cyrillic_response.results.len(), 1);
        assert_eq!(cyrillic_response.results[0].page_number, 1);
        assert_eq!(cyrillic_response.results[0].matched_text(), "ЁЖ");

        let accent_response =
            search_index(&index, &options("café")).expect("search should succeed");
        assert_eq!(accent_response.results.len(), 1);
        assert_eq!(accent_response.results[0].page_number, 2);
        assert_eq!(accent_response.results[0].matched_text(), "CAFÉ");

        let sigma_response = search_index(&index, &options("ς")).expect("search should succeed");
        assert_eq!(sigma_response.results.len(), 3);
        assert_eq!(sigma_response.results[0].matched_text(), "Σ");
        assert_eq!(sigma_response.results[1].matched_text(), "σ");
        assert_eq!(sigma_response.results[2].matched_text(), "ς");

        let kelvin_response = search_index(&index, &options("k")).expect("search should succeed");
        assert_eq!(kelvin_response.results.len(), 1);
        assert_eq!(kelvin_response.results[0].matched_text(), "K");

        let long_s_response = search_index(&index, &options("s")).expect("search should succeed");
        assert_eq!(long_s_response.results.len(), 1);
        assert_eq!(long_s_response.results[0].matched_text(), "ſ");
    }

    #[test]
    fn keeps_simple_case_folding_from_expanding_matches() {
        let index = test_index(&[(1, "İ ß")]);

        let dotted_i_response = search_index(&index, &options("i")).expect("search should succeed");
        assert!(dotted_i_response.results.is_empty());

        let sharp_s_response = search_index(&index, &options("ss")).expect("search should succeed");
        assert!(sharp_s_response.results.is_empty());
    }

    #[test]
    fn reports_utf16_offsets_for_page_text() {
        let index = test_index(&[(1, "\u{1F600} needle")]);
        let mut search_options = options("needle");
        search_options.match_case = true;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert_eq!(response.results[0].start_offset, 3);
        assert_eq!(response.results[0].end_offset, 9);
        assert_eq!(response.results[0].excerpt.matched_text, "needle");
    }

    #[test]
    fn truncates_at_result_limit() {
        let index = test_index(&[(1, "a a a a")]);
        let mut search_options = options("a");
        search_options.limit = 2;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert!(response.truncated);
        assert_eq!(response.results.len(), 2);
        assert_eq!(response.results[1].match_index, 1);
    }

    #[test]
    fn rejects_bad_index_magic() {
        let path = env::temp_dir().join(format!("evb-pdf-search-bad-magic-{}", process::id(),));
        fs::write(&path, b"not-index").expect("write temp file");
        let result = load_index(&path);
        fs::remove_file(&path).ok();

        assert!(result.is_err());
    }

    trait MatchText {
        fn matched_text(&self) -> &str;
    }

    impl MatchText for SearchMatch {
        fn matched_text(&self) -> &str {
            &self.excerpt.matched_text
        }
    }
}
