fn main() {
    evb_native_support::run_native_cli(
        evb_native_support::generated_native_tool_protocols::PDF_PAGE_OPS,
        env!("CARGO_PKG_VERSION"),
        std::env::args().skip(1),
        evb_pdf_page_ops::run_cli_entry,
    );
}
