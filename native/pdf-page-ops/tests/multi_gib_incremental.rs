#![cfg(target_family = "unix")]

use std::{
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

const SPARSE_STREAM_BYTES: u64 = 900 * 1024 * 1024;
const SPARSE_STREAM_COUNT: u32 = 6;

struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn temp_path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-page-ops-{label}-{}-{nonce}.{extension}",
        std::process::id()
    ))
}

fn write_object(file: &mut File, offsets: &mut Vec<u64>, object: &[u8]) {
    offsets.push(file.stream_position().unwrap());
    file.write_all(object).unwrap();
}

fn write_sparse_five_gib_pdf(path: &Path) -> u64 {
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = Vec::new();
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>>>\nendobj\n",
    );
    for object_number in 4..4 + SPARSE_STREAM_COUNT {
        offsets.push(file.stream_position().unwrap());
        file.write_all(
            format!("{object_number} 0 obj\n<</Length {SPARSE_STREAM_BYTES}>>\nstream\n")
                .as_bytes(),
        )
        .unwrap();
        file.seek(SeekFrom::Current(
            i64::try_from(SPARSE_STREAM_BYTES).unwrap(),
        ))
        .unwrap();
        file.write_all(b"\nendstream\nendobj\n").unwrap();
    }

    let xref_offset = file.stream_position().unwrap();
    assert!(xref_offset > u64::from(u32::MAX));
    let xref_size = 4 + SPARSE_STREAM_COUNT;
    file.write_all(format!("xref\n0 {xref_size}\n0000000000 65535 f \n").as_bytes())
        .unwrap();
    for offset in offsets {
        file.write_all(format!("{offset:010} 00000 n \n").as_bytes())
            .unwrap();
    }
    file.write_all(
        format!("trailer\n<</Size {xref_size}/Root 1 0 R>>\nstartxref\n{xref_offset}\n%%EOF\n")
            .as_bytes(),
    )
    .unwrap();
    file.sync_all().unwrap();
    fs::metadata(path).unwrap().len()
}

fn write_sparse_ten_gib_xref_stream_pdf(path: &Path) -> u64 {
    const STREAM_COUNT: u32 = 12;
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.7\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = vec![0_u64];
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>>>\nendobj\n",
    );
    for object_number in 4..4 + STREAM_COUNT {
        offsets.push(file.stream_position().unwrap());
        file.write_all(
            format!("{object_number} 0 obj\n<</Length {SPARSE_STREAM_BYTES}>>\nstream\n")
                .as_bytes(),
        )
        .unwrap();
        file.seek(SeekFrom::Current(
            i64::try_from(SPARSE_STREAM_BYTES).unwrap(),
        ))
        .unwrap();
        file.write_all(b"\nendstream\nendobj\n").unwrap();
    }

    let xref_object_number = 4 + STREAM_COUNT;
    let xref_offset = file.stream_position().unwrap();
    assert!(xref_offset > 10_000_000_000);
    offsets.push(xref_offset);
    let mut xref_content = Vec::with_capacity(offsets.len() * 11);
    xref_content.push(0);
    xref_content.extend_from_slice(&0_u64.to_be_bytes());
    xref_content.extend_from_slice(&u16::MAX.to_be_bytes());
    for offset in offsets.iter().skip(1) {
        xref_content.push(1);
        xref_content.extend_from_slice(&offset.to_be_bytes());
        xref_content.extend_from_slice(&0_u16.to_be_bytes());
    }
    let xref_size = xref_object_number + 1;
    file.write_all(
        format!(
            "{xref_object_number} 0 obj\n<</Type/XRef/Size {xref_size}/Root 1 0 R/W[1 8 2]/Index[0 {xref_size}]/Length {}>>\nstream\n",
            xref_content.len()
        )
        .as_bytes(),
    )
    .unwrap();
    file.write_all(&xref_content).unwrap();
    file.write_all(format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes())
        .unwrap();
    file.sync_all().unwrap();
    fs::metadata(path).unwrap().len()
}

fn write_sparse_near_ten_gib_classic_pdf(path: &Path) -> u64 {
    const TARGET_XREF_OFFSET: u64 = 9_999_999_700;
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = Vec::new();
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>>>\nendobj\n",
    );
    offsets.push(file.stream_position().unwrap());
    let stream_prefix = b"4 0 obj\n<</Length ";
    let stream_suffix = b">>\nstream\n";
    let object_suffix = b"\nendstream\nendobj\n";
    let mut stream_len = TARGET_XREF_OFFSET - file.stream_position().unwrap() - 64;
    loop {
        let header_len = stream_prefix.len() as u64
            + stream_len.to_string().len() as u64
            + stream_suffix.len() as u64;
        let end =
            file.stream_position().unwrap() + header_len + stream_len + object_suffix.len() as u64;
        if end == TARGET_XREF_OFFSET {
            break;
        }
        stream_len = stream_len
            .checked_add_signed(TARGET_XREF_OFFSET as i64 - end as i64)
            .unwrap();
    }
    file.write_all(stream_prefix).unwrap();
    write!(file, "{stream_len}").unwrap();
    file.write_all(stream_suffix).unwrap();
    file.seek(SeekFrom::Current(i64::try_from(stream_len).unwrap()))
        .unwrap();
    file.write_all(object_suffix).unwrap();
    assert_eq!(file.stream_position().unwrap(), TARGET_XREF_OFFSET);

    file.write_all(b"xref\n0 5\n0000000000 65535 f \n").unwrap();
    for offset in offsets {
        file.write_all(format!("{offset:010} 00000 n \n").as_bytes())
            .unwrap();
    }
    file.write_all(
        format!("trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n{TARGET_XREF_OFFSET}\n%%EOF\n")
            .as_bytes(),
    )
    .unwrap();
    file.sync_all().unwrap();
    let len = fs::metadata(path).unwrap().len();
    assert!(len < 10_000_000_000);
    len
}

fn qpdf_path() -> PathBuf {
    env::var_os("QPDF_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("qpdf"))
}

fn append_bookmark(pdf: &Path, mutations: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(pdf)
        .arg("--output")
        .arg(pdf)
        .arg("--mutations-file")
        .arg(mutations)
        .arg("--qpdf")
        .arg(qpdf_path())
        .args(["--modified-at", "D:20260826120000Z", "--append"])
        .output()
        .unwrap()
}

fn assert_qpdf_check(pdf: &Path) {
    let output = Command::new(qpdf_path())
        .args(["--check", "--suppress-recovery", "--"])
        .arg(pdf)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "qpdf --check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn terminal_xref_marker(pdf: &Path) -> [u8; 4] {
    let mut file = File::open(pdf).unwrap();
    let len = file.metadata().unwrap().len();
    file.seek(SeekFrom::Start(len.saturating_sub(1_024)))
        .unwrap();
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).unwrap();
    let marker = tail
        .windows(b"startxref".len())
        .rposition(|window| window == b"startxref")
        .unwrap();
    let xref_offset = std::str::from_utf8(&tail[marker + b"startxref".len()..])
        .unwrap()
        .trim_start()
        .split_ascii_whitespace()
        .next()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    file.seek(SeekFrom::Start(xref_offset)).unwrap();
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes).unwrap();
    bytes
}

#[test]
fn appends_metadata_to_a_sparse_pdf_beyond_four_gib() {
    let pdf = temp_path("five-gib-append", "pdf");
    let mutations = temp_path("five-gib-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_five_gib_pdf(&pdf);
    fs::write(
        &mutations,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();

    let output = append_bookmark(&pdf, &mutations);
    assert!(
        output.status.success(),
        "append failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fs::metadata(&pdf).unwrap().len() > original_len);
    assert_qpdf_check(&pdf);
}

#[test]
fn appends_metadata_beyond_the_ten_gb_classic_xref_limit() {
    let pdf = temp_path("ten-gb-xref-stream-append", "pdf");
    let mutations = temp_path("ten-gb-xref-stream-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_ten_gib_xref_stream_pdf(&pdf);
    fs::write(
        &mutations,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();

    let output = append_bookmark(&pdf, &mutations);
    assert!(
        output.status.success(),
        "append failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fs::metadata(&pdf).unwrap().len() > original_len);
    assert_qpdf_check(&pdf);
}

#[test]
fn upgrades_a_classic_xref_when_the_append_crosses_ten_billion_bytes() {
    let pdf = temp_path("classic-xref-ceiling-append", "pdf");
    let mutations = temp_path("classic-xref-ceiling-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_near_ten_gib_classic_pdf(&pdf);
    fs::write(
        &mutations,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();

    let output = append_bookmark(&pdf, &mutations);
    assert!(
        output.status.success(),
        "append failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let final_len = fs::metadata(&pdf).unwrap().len();
    assert!(final_len > original_len);
    assert!(final_len > 10_000_000_000);
    assert_ne!(terminal_xref_marker(&pdf), *b"xref");
    let catalog = Command::new(qpdf_path())
        .args(["--show-object=1", "--"])
        .arg(&pdf)
        .output()
        .unwrap();
    assert!(catalog.status.success());
    assert!(String::from_utf8_lossy(&catalog.stdout).contains("/Version /1.5"));
    assert_qpdf_check(&pdf);
}
