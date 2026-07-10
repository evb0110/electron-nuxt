use serde::Serialize;
use std::env;
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::process;
use unicode_casefold::{Locale, UnicodeCaseFold, Variant};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: u32 = 1;
const MAGIC: &[u8; 8] = b"EVBSIDX2";
const SCHEMA_VERSION: u32 = 2;
const HEADER_SIZE: usize = 64;
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
    document_revision: String,
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
    "Usage: evb-pdf-search search --index <path> --query <text> --document-revision <token> [--limit <n>] [--context <n>] [--match-case] [--page-count <n>]"
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

fn load_index(path: &PathBuf, expected_revision: &str) -> Result<SearchIndex, Box<dyn Error>> {
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

    let header_size = usize::try_from(read_u32_le(&data, 12)?)
        .map_err(|_| CliError("Native search index header size is too large".to_string()))?;
    if header_size != HEADER_SIZE {
        return Err(Box::new(CliError(
            "Native search index header size mismatch".to_string(),
        )));
    }

    let page_count = read_u32_le(&data, 16)?;
    let page_record_count = read_u32_le(&data, 20)?;
    let revision_token_byte_length = usize::try_from(read_u32_le(&data, 28)?)
        .map_err(|_| CliError("Native search index revision token is too large".to_string()))?;
    let revision_token_byte_offset =
        usize_from_u64(read_u64_le(&data, 32)?, "revision token byte offset")?;
    let page_table_offset = usize_from_u64(read_u64_le(&data, 40)?, "page table offset")?;
    let text_data_offset = usize_from_u64(read_u64_le(&data, 48)?, "text data offset")?;
    let revision_token_end = revision_token_byte_offset
        .checked_add(revision_token_byte_length)
        .ok_or_else(|| {
            CliError("Native search index revision token offset overflow".to_string())
        })?;
    if revision_token_byte_length == 0
        || revision_token_byte_offset < HEADER_SIZE
        || revision_token_end > page_table_offset
    {
        return Err(Box::new(CliError(
            "Native search index revision token is invalid".to_string(),
        )));
    }
    let revision_token = std::str::from_utf8(
        data.get(revision_token_byte_offset..revision_token_end)
            .ok_or_else(|| {
                CliError("Native search index revision token is truncated".to_string())
            })?,
    )?;
    if revision_token != expected_revision {
        return Err(Box::new(CliError(
            "Native search index document revision mismatch".to_string(),
        )));
    }

    let page_record_count_usize = usize::try_from(page_record_count)
        .map_err(|_| CliError("Native search index page count is too large".to_string()))?;
    let table_size = page_record_count_usize
        .checked_mul(PAGE_RECORD_SIZE)
        .ok_or_else(|| CliError("Native search index table is too large".to_string()))?;
    let minimum_size = page_table_offset
        .checked_add(table_size)
        .ok_or_else(|| CliError("Native search index table offset overflow".to_string()))?;
    if text_data_offset < minimum_size || data.len() < text_data_offset {
        return Err(Box::new(CliError(
            "Native search index page table is truncated".to_string(),
        )));
    }

    let mut records = Vec::with_capacity(page_record_count_usize);
    for record_index in 0..page_record_count_usize {
        let record_offset = page_table_offset + record_index * PAGE_RECORD_SIZE;
        let page_number = read_u32_le(&data, record_offset)?;
        let byte_offset = usize_from_u64(read_u64_le(&data, record_offset + 8)?, "byte offset")?;
        let byte_len = usize_from_u64(read_u64_le(&data, record_offset + 16)?, "byte length")?;
        let byte_end = byte_offset
            .checked_add(byte_len)
            .ok_or_else(|| CliError("Native search index page text offset overflow".to_string()))?;
        if byte_offset < text_data_offset || byte_end > data.len() {
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
    let mut document_revision: Option<String> = None;

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
            "--document-revision" => {
                document_revision = Some(args.next().ok_or_else(|| {
                    CliError("Missing value for --document-revision".to_string())
                })?);
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
        document_revision: document_revision
            .filter(|revision| !revision.is_empty())
            .ok_or_else(|| CliError("Missing required --document-revision".to_string()))?,
    })
}

fn ascii_bytes_equal_ignore_case(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left_byte, right_byte)| left_byte.eq_ignore_ascii_case(right_byte))
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

enum MatchScanner<'a> {
    CaseSensitive {
        cursor: usize,
        needle: &'a str,
        text: &'a str,
    },
    AsciiCaseInsensitive {
        cursor: usize,
        needle: &'a [u8],
        text: &'a str,
    },
    UnicodeCaseInsensitive {
        cursor: usize,
        folded_needle: String,
        folded_text: FoldedText,
    },
}

impl<'a> MatchScanner<'a> {
    fn new(text: &'a str, needle: &'a str, match_case: bool) -> Self {
        if match_case {
            Self::CaseSensitive {
                cursor: 0,
                needle,
                text,
            }
        } else if text.is_ascii() && needle.is_ascii() {
            Self::AsciiCaseInsensitive {
                cursor: 0,
                needle: needle.as_bytes(),
                text,
            }
        } else {
            Self::UnicodeCaseInsensitive {
                cursor: 0,
                folded_needle: simple_case_fold(needle),
                folded_text: fold_text_with_spans(text),
            }
        }
    }
}

impl Iterator for MatchScanner<'_> {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::CaseSensitive {
                cursor,
                needle,
                text,
            } => {
                if needle.is_empty() || *cursor >= text.len() {
                    return None;
                }
                let relative_start = text[*cursor..].find(*needle)?;
                let start = *cursor + relative_start;
                let end = start + needle.len();
                *cursor = end;
                Some((start, end))
            }
            Self::AsciiCaseInsensitive {
                cursor,
                needle,
                text,
            } => {
                let haystack = text.as_bytes();
                while !needle.is_empty() && *cursor + needle.len() <= haystack.len() {
                    let start = *cursor;
                    let end = start + needle.len();
                    if ascii_bytes_equal_ignore_case(&haystack[start..end], needle)
                        && text.is_char_boundary(start)
                        && text.is_char_boundary(end)
                    {
                        *cursor = end;
                        return Some((start, end));
                    }
                    *cursor += 1;
                }
                None
            }
            Self::UnicodeCaseInsensitive {
                cursor,
                folded_needle,
                folded_text,
            } => {
                while !folded_needle.is_empty() && *cursor < folded_text.text.len() {
                    let relative_start =
                        folded_text.text[*cursor..].find(folded_needle.as_str())?;
                    let start = *cursor + relative_start;
                    let end = start + folded_needle.len();
                    *cursor = end;
                    if let Some(original_range) =
                        original_byte_range_for_folded_match(folded_text, start, end)
                    {
                        return Some(original_range);
                    }
                }
                None
            }
        }
    }
}

struct PageTextMap {
    byte_offsets: Vec<usize>,
    utf16_offsets: Vec<usize>,
}

impl PageTextMap {
    fn new(text: &str) -> Self {
        let mut byte_offsets = Vec::new();
        let mut utf16_offsets = Vec::new();
        let mut utf16_offset = 0usize;
        for (byte_offset, character) in text.char_indices() {
            byte_offsets.push(byte_offset);
            utf16_offsets.push(utf16_offset);
            utf16_offset += character.len_utf16();
        }
        byte_offsets.push(text.len());
        utf16_offsets.push(utf16_offset);
        Self {
            byte_offsets,
            utf16_offsets,
        }
    }

    fn utf16_offset_for_byte(&self, byte_offset: usize) -> usize {
        let index = self
            .byte_offsets
            .binary_search(&byte_offset)
            .expect("match offsets are character boundaries");
        self.utf16_offsets[index]
    }

    fn byte_index_for_utf16_offset(&self, target_offset: usize) -> usize {
        match self.utf16_offsets.binary_search(&target_offset) {
            Ok(index) => self.byte_offsets[index],
            Err(0) => 0,
            Err(index) => self.byte_offsets[index - 1],
        }
    }

    fn utf16_len(&self) -> usize {
        self.utf16_offsets.last().copied().unwrap_or(0)
    }
}

fn collapse_whitespace(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_whitespace = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
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

fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character != '\u{85}' && character.is_whitespace())
}

fn trim_js_whitespace_start(value: &str) -> &str {
    let Some((start, _)) = value
        .char_indices()
        .find(|(_, character)| !is_js_whitespace(*character))
    else {
        return "";
    };
    &value[start..]
}

fn trim_js_whitespace_end(value: &str) -> &str {
    let Some((end_start, end_character)) = value
        .char_indices()
        .rev()
        .find(|(_, character)| !is_js_whitespace(*character))
    else {
        return "";
    };
    &value[..end_start + end_character.len_utf8()]
}

fn build_excerpt(
    text: &str,
    text_map: &PageTextMap,
    start_byte_offset: usize,
    end_byte_offset: usize,
    start_utf16_offset: usize,
    end_utf16_offset: usize,
    context_chars: usize,
) -> SearchExcerpt {
    let text_utf16_len = text_map.utf16_len();
    let excerpt_start_utf16 = start_utf16_offset.saturating_sub(context_chars);
    let excerpt_end_utf16 = text_utf16_len.min(end_utf16_offset.saturating_add(context_chars));
    let excerpt_start_byte = text_map.byte_index_for_utf16_offset(excerpt_start_utf16);
    let excerpt_end_byte = text_map.byte_index_for_utf16_offset(excerpt_end_utf16);

    let before_collapsed = collapse_whitespace(&text[excerpt_start_byte..start_byte_offset]);
    let before = trim_js_whitespace_start(&before_collapsed).to_string();
    let after_collapsed = collapse_whitespace(&text[end_byte_offset..excerpt_end_byte]);
    let after = trim_js_whitespace_end(&after_collapsed).to_string();

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
    search_index_with_work_count(index, options).map(|(response, _)| response)
}

fn search_index_with_work_count(
    index: &SearchIndex,
    options: &SearchOptions,
) -> Result<(SearchResponse, usize), Box<dyn Error>> {
    let total_pages = options.page_count.unwrap_or(index.page_count);
    let mut results = Vec::new();
    let mut truncated = false;
    let mut matches_examined = 0usize;

    'pages: for record in &index.records {
        if record.page_number == 0 || record.page_number > total_pages {
            continue;
        }

        let text = index.page_text(record)?;
        let mut text_map: Option<PageTextMap> = None;
        let mut page_match_index = 0usize;
        for (start_byte, end_byte) in MatchScanner::new(text, &options.query, options.match_case) {
            matches_examined += 1;
            if results.len() >= options.limit {
                truncated = true;
                break 'pages;
            }

            let text_map = text_map.get_or_insert_with(|| PageTextMap::new(text));
            let start_offset = text_map.utf16_offset_for_byte(start_byte);
            let end_offset = text_map.utf16_offset_for_byte(end_byte);
            results.push(SearchMatch {
                page_number: record.page_number,
                page_match_index,
                match_index: results.len(),
                start_offset,
                end_offset,
                excerpt: build_excerpt(
                    text,
                    &text_map,
                    start_byte,
                    end_byte,
                    start_offset,
                    end_offset,
                    options.context_chars,
                ),
            });
            page_match_index += 1;
        }
    }

    Ok((
        SearchResponse {
            results,
            truncated,
            page_count: total_pages,
        },
        matches_examined,
    ))
}

fn run_cli(mut args: impl Iterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let Some(command) = args.next() else {
        return Err(Box::new(CliError(usage().to_string())));
    };

    match command.as_str() {
        "--protocol-version" => {
            println!("{PROTOCOL_VERSION}");
            Ok(())
        }
        "--version" | "-V" => {
            println!("evb-pdf-search {VERSION}");
            Ok(())
        }
        "search" => {
            let options = parse_search_options(args)?;
            let index = load_index(&options.index_path, &options.document_revision)?;
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
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceCorpus {
        cases: Vec<SearchConformanceCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceCase {
        id: String,
        text: String,
        query: String,
        options: Option<SearchConformanceOptions>,
        context_chars: usize,
        native_supported: bool,
        expected_matches: Vec<SearchConformanceExpectedMatch>,
    }

    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceOptions {
        match_case: Option<bool>,
        whole_word: Option<bool>,
        use_regex: Option<bool>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceExpectedMatch {
        start_offset: usize,
        end_offset: usize,
        excerpt: SearchConformanceExpectedExcerpt,
    }

    #[derive(Deserialize, Debug, PartialEq, Eq)]
    struct SearchConformanceExpectedExcerpt {
        prefix: bool,
        suffix: bool,
        before: String,
        #[serde(rename = "match")]
        matched_text: String,
        after: String,
    }

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

    const TEST_DOCUMENT_REVISION: &str = "revision-token";

    fn serialized_index(pages: &[(u32, &str)]) -> Vec<u8> {
        let header_size = HEADER_SIZE;
        let revision_token = TEST_DOCUMENT_REVISION.as_bytes();
        let table_size = pages.len() * PAGE_RECORD_SIZE;
        let page_table_offset = header_size + revision_token.len();
        let text_data_offset = page_table_offset + table_size;
        let mut text_offset = text_data_offset;
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
        data.extend_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        data.extend_from_slice(&(pages.len() as u32).to_le_bytes());
        data.extend_from_slice(&(pages.len() as u32).to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&(revision_token.len() as u32).to_le_bytes());
        data.extend_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
        data.extend_from_slice(&(page_table_offset as u64).to_le_bytes());
        data.extend_from_slice(&(text_data_offset as u64).to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(revision_token);

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
            document_revision: TEST_DOCUMENT_REVISION.to_string(),
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

        let index = load_index(&path, TEST_DOCUMENT_REVISION).expect("load native search index");
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
    fn rejects_native_index_with_mismatched_document_revision() {
        let path = env::temp_dir().join(format!("evb-pdf-search-revision-{}", process::id()));
        fs::write(&path, serialized_index(&[(1, "one Alpha two")]))
            .expect("write temp native search index");

        let error = load_index(&path, "other-token").expect_err("revision mismatch should fail");
        fs::remove_file(&path).ok();

        assert!(error.to_string().contains("document revision mismatch"));
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
    fn limit_one_bounds_dense_page_match_work() {
        let dense_text = "a ".repeat(100_000);
        let index = test_index(&[(1, &dense_text)]);
        let mut search_options = options("a");
        search_options.limit = 1;

        let (response, matches_examined) =
            search_index_with_work_count(&index, &search_options).expect("search should succeed");

        assert_eq!(response.results.len(), 1);
        assert!(response.truncated);
        assert_eq!(
            matches_examined, 2,
            "only the result and truncation probe run"
        );
    }

    #[test]
    fn zero_limit_returns_no_matches_and_tracks_truncation() {
        let index = test_index(&[(1, "alpha"), (2, "beta")]);
        let mut search_options = options("alpha");
        search_options.limit = 0;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert!(response.results.is_empty());
        assert!(response.truncated);

        search_options.query = "gamma".to_string();
        let response = search_index(&index, &search_options).expect("search should succeed");

        assert!(response.results.is_empty());
        assert!(!response.truncated);
    }

    #[test]
    fn does_not_truncate_when_result_count_equals_limit() {
        let index = test_index(&[(1, "a a")]);
        let mut search_options = options("a");
        search_options.limit = 2;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert_eq!(response.results.len(), 2);
        assert!(!response.truncated);
    }

    #[test]
    fn builds_excerpt_with_javascript_whitespace_rules() {
        let text = "\u{feff}\u{85}Needle\u{85}\u{feff}";
        let start_byte = text.find("Needle").unwrap();
        let end_byte = start_byte + "Needle".len();
        let text_map = PageTextMap::new(text);

        let excerpt = build_excerpt(
            text,
            &text_map,
            start_byte,
            end_byte,
            text_map.utf16_offset_for_byte(start_byte),
            text_map.utf16_offset_for_byte(end_byte),
            10,
        );

        assert_eq!(excerpt.before, "\u{85}");
        assert_eq!(excerpt.after, "\u{85}");
    }

    #[test]
    fn matches_shared_conformance_corpus_native_subset() {
        let corpus: SearchConformanceCorpus = serde_json::from_str(include_str!(
            "../../../packages/contracts/searchConformanceCorpus.json"
        ))
        .expect("parse search conformance corpus");

        for case in corpus.cases.iter().filter(|case| case.native_supported) {
            let options_ref = case.options.as_ref();
            assert!(
                !options_ref
                    .and_then(|value| value.whole_word)
                    .unwrap_or(false),
                "native corpus case {} must not require whole-word matching",
                case.id,
            );
            assert!(
                !options_ref
                    .and_then(|value| value.use_regex)
                    .unwrap_or(false),
                "native corpus case {} must not require regex matching",
                case.id,
            );
            let mut search_options = options(&case.query);
            search_options.context_chars = case.context_chars;
            search_options.match_case = options_ref
                .and_then(|value| value.match_case)
                .unwrap_or(false);
            let response = search_index(&test_index(&[(1, &case.text)]), &search_options)
                .expect("search corpus case");

            assert_eq!(
                response.results.len(),
                case.expected_matches.len(),
                "case {} result count",
                case.id,
            );
            for (actual, expected) in response.results.iter().zip(&case.expected_matches) {
                assert_eq!(
                    actual.start_offset, expected.start_offset,
                    "case {} start",
                    case.id,
                );
                assert_eq!(
                    actual.end_offset, expected.end_offset,
                    "case {} end",
                    case.id,
                );
                assert_eq!(
                    SearchConformanceExpectedExcerpt {
                        prefix: actual.excerpt.prefix,
                        suffix: actual.excerpt.suffix,
                        before: actual.excerpt.before.clone(),
                        matched_text: actual.excerpt.matched_text.clone(),
                        after: actual.excerpt.after.clone(),
                    },
                    expected.excerpt,
                    "case {} excerpt",
                    case.id,
                );
            }
        }
    }

    #[test]
    fn rejects_bad_index_magic() {
        let path = env::temp_dir().join(format!("evb-pdf-search-bad-magic-{}", process::id(),));
        fs::write(&path, b"not-index").expect("write temp file");
        let result = load_index(&path, TEST_DOCUMENT_REVISION);
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
