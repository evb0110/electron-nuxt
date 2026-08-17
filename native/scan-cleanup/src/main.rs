fn main() {
    evb_native_support::run_native_cli(
        evb_native_support::generated_native_tool_protocols::SCAN_CLEANUP,
        env!("CARGO_PKG_VERSION"),
        std::env::args().skip(1),
        evb_scan_cleanup::cli::run,
    );
}
