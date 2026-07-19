fn main() {
    evb_native_support::run_cli_caught(|| evb_scan_cleanup::cli::run(std::env::args().skip(1)));
}
