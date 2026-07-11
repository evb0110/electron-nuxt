use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

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

#[test]
fn persistent_service_searches_over_framed_stdio() {
    let directory =
        std::env::temp_dir().join(format!("evb-pdf-search-service-{}", std::process::id()));
    fs::create_dir_all(&directory).expect("create service fixture directory");
    let index_path = directory.join("document.search-index.bin");
    write_index(&index_path, "Alpha beta alpha");

    let mut child = Command::new(env!("CARGO_BIN_EXE_evb-pdf-search"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn persistent search service");
    let mut stdin = child.stdin.take().expect("search service stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("search service stdout"));

    let mut line = String::new();
    stdout.read_line(&mut line).expect("read ready frame");
    let ready: Value = serde_json::from_str(&line).expect("parse ready frame");
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["protocolVersion"], 1);

    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "type": "search",
            "requestId": "invalid-request",
            "indexPath": index_path,
            "query": "alpha",
            "documentRevision": REVISION,
            "unexpectedField": true
        })
    )
    .expect("write invalid search frame");
    stdin.flush().expect("flush invalid search frame");
    line.clear();
    stdout
        .read_line(&mut line)
        .expect("read structured error frame");
    let invalid: Value = serde_json::from_str(&line).expect("parse structured error frame");
    assert_eq!(invalid["type"], "error");
    assert_eq!(invalid["error"]["code"], "invalid-request");

    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "type": "search",
            "requestId": "request-1",
            "indexPath": index_path,
            "query": "alpha",
            "documentRevision": REVISION,
            "limit": 10,
            "contextChars": 4,
            "matchCase": false,
            "pageCount": 1
        })
    )
    .expect("write search frame");
    stdin.flush().expect("flush search frame");

    line.clear();
    stdout.read_line(&mut line).expect("read result frame");
    let result: Value = serde_json::from_str(&line).expect("parse result frame");
    assert_eq!(result["type"], "result");
    assert_eq!(result["requestId"], "request-1");
    assert_eq!(result["result"]["results"].as_array().unwrap().len(), 2);

    child.kill().expect("stop search service");
    let _ = child.wait();
    fs::remove_dir_all(directory).expect("remove service fixture directory");
}
