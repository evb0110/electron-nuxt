use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const HEADER_SIZE: usize = 64;
const PAGE_RECORD_SIZE: usize = 24;
const REVISION: &str = "service-test-revision";

fn write_index(path: &Path, text: &str) {
    let revision = REVISION.as_bytes();
    let page_table_offset = HEADER_SIZE + revision.len();
    let text_offset = page_table_offset + PAGE_RECORD_SIZE;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"EVBSIDX2");
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(revision.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
    bytes.extend_from_slice(&(page_table_offset as u64).to_le_bytes());
    bytes.extend_from_slice(&(text_offset as u64).to_le_bytes());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(revision);
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(text_offset as u64).to_le_bytes());
    bytes.extend_from_slice(&(text.len() as u64).to_le_bytes());
    bytes.extend_from_slice(text.as_bytes());
    fs::write(path, bytes).expect("write search service index");
}

fn fixture_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "evb-pdf-search-service-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).expect("create service fixture directory");
    directory
}

fn search_request(request_id: &str, index_path: &Path, query: &str) -> Value {
    serde_json::json!({
        "type": "search",
        "requestId": request_id,
        "indexPath": index_path,
        "query": query,
        "documentRevision": REVISION,
        "limit": 10,
        "contextChars": 4,
        "matchCase": false,
        "pageCount": 1
    })
}

struct SearchService {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl SearchService {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_evb-pdf-search"))
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn persistent search service");
        let stdin = child.stdin.take().expect("search service stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("search service stdout"));
        let mut line = String::new();
        stdout.read_line(&mut line).expect("read ready frame");
        let ready: Value = serde_json::from_str(&line).expect("parse ready frame");
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["protocolVersion"], 1);
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn request(&mut self, request: &Value) -> Value {
        self.request_raw(&request.to_string())
    }

    fn request_raw(&mut self, request: &str) -> Value {
        self.send_raw(request);
        let mut line = String::new();
        self.stdout
            .read_line(&mut line)
            .expect("read search service response");
        serde_json::from_str(&line).expect("parse search service response")
    }

    fn send_raw(&mut self, request: &str) {
        writeln!(self.stdin, "{request}").expect("write search service frame");
        self.stdin.flush().expect("flush search service frame");
    }
}

impl Drop for SearchService {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn persistent_service_searches_over_framed_stdio() {
    let directory = fixture_directory("success");
    let index_path = directory.join("document.search-index.bin");
    write_index(&index_path, "Alpha beta alpha");
    let mut service = SearchService::spawn();

    let result = service.request(&search_request("request-1", &index_path, "alpha"));
    assert_eq!(result["type"], "result");
    assert_eq!(result["requestId"], "request-1");
    assert_eq!(result["result"]["results"].as_array().unwrap().len(), 2);

    drop(service);
    fs::remove_dir_all(directory).expect("remove service fixture directory");
}

#[test]
fn malformed_corrupt_and_oversized_frames_return_exact_codes_without_panicking() {
    let directory = fixture_directory("errors");
    let valid_path = directory.join("valid.search-index.bin");
    let corrupt_path = directory.join("corrupt.search-index.bin");
    let oversized_path = directory.join("oversized.search-index.bin");
    write_index(&valid_path, "still alive");
    fs::write(&corrupt_path, b"not-an-index").unwrap();
    File::create(&oversized_path)
        .unwrap()
        .set_len((320 * 1024 * 1024) + 1)
        .unwrap();
    let mut service = SearchService::spawn();

    let malformed = service.request_raw("{not-json}");
    assert_eq!(malformed["type"], "error");
    assert_eq!(malformed["error"]["code"], "invalid-request");
    assert_ne!(malformed["error"]["code"], "panic");

    let corrupt = service.request(&search_request("corrupt", &corrupt_path, "query"));
    assert_eq!(corrupt["type"], "error");
    assert_eq!(corrupt["error"]["code"], "native-failure");
    assert_ne!(corrupt["error"]["code"], "panic");

    let oversized = service.request(&search_request("oversized", &oversized_path, "query"));
    assert_eq!(oversized["type"], "error");
    assert_eq!(oversized["error"]["code"], "too-large");
    assert!(oversized["error"]["message"]
        .as_str()
        .unwrap()
        .contains("335544320-byte admission ceiling"));

    let recovery = service.request(&search_request("recovery", &valid_path, "alive"));
    assert_eq!(recovery["type"], "result");
    assert_eq!(recovery["requestId"], "recovery");

    drop(service);
    fs::remove_dir_all(directory).expect("remove service fixture directory");
}

#[test]
fn service_cache_evicts_the_least_recently_used_index_and_reloads_it() {
    let directory = fixture_directory("cache");
    let first_path = directory.join("index-0.bin");
    write_index(&first_path, "original token");
    let mut service = SearchService::spawn();

    let first = service.request(&search_request("first", &first_path, "original"));
    assert_eq!(first["type"], "result");
    for index in 1..=8 {
        let index_path = directory.join(format!("index-{index}.bin"));
        write_index(&index_path, &format!("cache token {index}"));
        let response = service.request(&search_request(
            &format!("fill-{index}"),
            &index_path,
            &index.to_string(),
        ));
        assert_eq!(response["type"], "result", "{response}");
    }

    write_index(&first_path, "replacement token");
    let reloaded = service.request(&search_request("reloaded", &first_path, "replacement"));
    assert_eq!(reloaded["type"], "result", "{reloaded}");
    assert_eq!(reloaded["result"]["results"].as_array().unwrap().len(), 1);

    drop(service);
    fs::remove_dir_all(directory).expect("remove service fixture directory");
}

#[test]
fn reset_cache_reloads_an_atomic_same_revision_replacement() {
    let directory = fixture_directory("reset-cache");
    let index_path = directory.join("document.search-index.bin");
    let replacement_path = directory.join("replacement.search-index.bin");
    write_index(&index_path, "original token");
    let mut service = SearchService::spawn();

    let original = service.request(&search_request("original", &index_path, "original"));
    assert_eq!(original["type"], "result");
    assert_eq!(original["result"]["results"].as_array().unwrap().len(), 1);

    write_index(&replacement_path, "replacement token");
    fs::rename(&replacement_path, &index_path).expect("replace search index atomically");
    service.send_raw(r#"{"type":"reset-cache"}"#);

    let replacement = service.request(&search_request("replacement", &index_path, "replacement"));
    assert_eq!(replacement["type"], "result", "{replacement}");
    assert_eq!(
        replacement["result"]["results"].as_array().unwrap().len(),
        1
    );

    drop(service);
    fs::remove_dir_all(directory).expect("remove service fixture directory");
}
