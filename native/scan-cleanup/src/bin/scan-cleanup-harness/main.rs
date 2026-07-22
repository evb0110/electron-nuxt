mod corpus;
mod evaluate;
mod report;

use evaluate::{compare_catastrophes, evaluate_corpus};
use rayon::ThreadPoolBuilder;
use report::{read_baseline, write_reports};
use std::{env, path::PathBuf, process::ExitCode};

const DEFAULT_THREADS: usize = 1;

#[derive(Debug)]
struct Arguments {
    out: PathBuf,
    baseline: Option<PathBuf>,
}

fn main() -> ExitCode {
    let arguments = match parse_arguments() {
        Ok(Some(arguments)) => arguments,
        Ok(None) => return ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("scan-cleanup-harness: {error}");
            return ExitCode::from(2);
        }
    };
    match run(arguments) {
        Ok(regressions) if regressions.is_empty() => ExitCode::SUCCESS,
        Ok(regressions) => {
            eprintln!("catastrophe budget exceeded:");
            for regression in regressions {
                eprintln!("  {regression}");
            }
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("scan-cleanup-harness: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(arguments: Arguments) -> Result<Vec<String>, String> {
    let corpus = corpus::build_corpus()?;
    let pool = ThreadPoolBuilder::new()
        .num_threads(DEFAULT_THREADS)
        .build()
        .map_err(|error| format!("failed to build fixed-size thread pool: {error}"))?;
    let report = pool.install(|| evaluate_corpus(&corpus, DEFAULT_THREADS))?;
    write_reports(&arguments.out, &report)?;

    println!(
        "wrote {} and {}",
        arguments.out.join("report.md").display(),
        arguments.out.join("report.json").display()
    );
    println!("catastrophes: {}", report.comparable.total_catastrophes());

    arguments
        .baseline
        .map(|path| {
            let baseline = read_baseline(&path)?;
            compare_catastrophes(&report.comparable, &baseline)
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

fn parse_arguments() -> Result<Option<Arguments>, String> {
    let mut out = default_output_directory();
    let mut baseline = None;
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--" => continue,
            "--out" => {
                out = PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--out requires a directory".to_string())?,
                );
            }
            "--baseline" => {
                baseline =
                    Some(PathBuf::from(arguments.next().ok_or_else(|| {
                        "--baseline requires a JSON path".to_string()
                    })?));
            }
            "--help" | "-h" => {
                println!(
                    "Usage: scan-cleanup-harness [--out <directory>] [--baseline <report.json>]\n\
                     Default output: <repository>/.devkit/scratch/scan-cleanup-harness/"
                );
                return Ok(None);
            }
            _ => return Err(format!("unknown argument: {argument}")),
        }
    }
    Ok(Some(Arguments { out, baseline }))
}

fn default_output_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".devkit/scratch/scan-cleanup-harness")
}
