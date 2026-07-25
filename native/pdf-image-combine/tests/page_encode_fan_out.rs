use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const FIXTURES: [&str; 4] = [
    "scan-page-000-body.pbm",
    "scan-page-002-body.pbm",
    "scan-page-007-notes.pbm",
    "scan-page-000-body-509.pbm",
];

#[test]
fn concurrent_page_encoding_produces_the_same_bytes_and_page_order_as_one_thread() {
    let scratch = Scratch::new("fan-out");
    let manifest = scratch.path("manifest.tsv");
    fs::write(&manifest, manifest_lines(12)).unwrap();

    let single = combine(&manifest, &scratch.path("single.pdf"), 1);
    let concurrent = combine(&manifest, &scratch.path("concurrent.pdf"), 8);

    assert!(
        single.pdf == concurrent.pdf,
        "combined bytes must not depend on the encoder fan-out: {} vs {} bytes",
        single.pdf.len(),
        concurrent.pdf.len()
    );
    assert_eq!(single.progress, (1..=12).collect::<Vec<_>>());
    assert_eq!(concurrent.progress, (1..=12).collect::<Vec<_>>());

    // Page N must carry fixture N of the repeating manifest cycle: the 509-wide
    // fixture pins the position of every fourth page against reordering.
    let widths = image_widths(&concurrent.pdf);
    assert_eq!(widths.len(), 12);
    for (index, width) in widths.into_iter().enumerate() {
        let expected = if index % FIXTURES.len() == 3 {
            509
        } else {
            512
        };
        assert_eq!(
            width,
            expected,
            "page {} is out of manifest order",
            index + 1
        );
    }
}

#[test]
fn a_failing_page_fails_the_whole_combine_under_fan_out() {
    let scratch = Scratch::new("fan-out-failure");
    let manifest = scratch.path("manifest.tsv");
    let truncated = scratch.path("truncated.pbm");
    fs::write(&truncated, b"P4\n512 512\n").unwrap();
    fs::write(
        &manifest,
        format!(
            "{}image-bilevel\t144\t144\t{}\n",
            manifest_lines(3),
            truncated.display()
        ),
    )
    .unwrap();

    let output = run(&manifest, &scratch.path("out.pdf"), 8);

    assert!(!output.status.success());
    assert!(!scratch.path("out.pdf").exists());
}

struct Combined {
    pdf: Vec<u8>,
    progress: Vec<u64>,
}

fn combine(manifest: &Path, output_path: &Path, threads: u32) -> Combined {
    let output = run(manifest, output_path, threads);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Combined {
        pdf: fs::read(output_path).unwrap(),
        progress: String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["processed"]
                    .as_u64()
                    .unwrap()
            })
            .collect(),
    }
}

fn run(manifest: &Path, output_path: &Path, threads: u32) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output"])
        .arg(output_path)
        .args(["--compact-manifest"])
        .arg(manifest)
        .arg("--json-progress")
        .env("EVB_PDF_COMBINE_THREADS", threads.to_string())
        .output()
        .unwrap()
}

fn manifest_lines(pages: usize) -> String {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../jbig2-codec/tests/fixtures");
    (0..pages)
        .map(|page| {
            format!(
                "image-bilevel\t144\t144\t{}\n",
                fixtures.join(FIXTURES[page % FIXTURES.len()]).display()
            )
        })
        .collect()
}

fn image_widths(pdf: &[u8]) -> Vec<u32> {
    String::from_utf8_lossy(pdf)
        .match_indices("/Subtype /Image /Width ")
        .map(|(index, marker)| {
            String::from_utf8_lossy(pdf)[index + marker.len()..]
                .split_whitespace()
                .next()
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect()
}

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(test: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "evb-pdf-image-combine-{test}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
