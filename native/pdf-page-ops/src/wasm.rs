use evb_native_support::{NativeErrorCode, NativeErrorEnvelope};
use std::{cell::RefCell, mem, slice};

use crate::{
    crop_browser_pdf_bytes, delete_browser_pdf_pages, extract_browser_pdf_pages,
    get_browser_page_geometry_from_bytes, insert_browser_pdf_pages, remove_crop_browser_pdf_bytes,
    reorder_browser_pdf_pages, rotate_browser_pdf_bytes, CropMargins, PageGeometry,
    PageMutationBytes, PdfRect, Result, PAGE_OP_WASM_MAX_OUTPUT_BYTES,
    PAGE_OP_WASM_MUTATION_HEADER_BYTES,
};

const REQUEST_MAGIC: &[u8; 4] = b"EPPO";
const REQUEST_VERSION: u32 = 1;

const OP_DELETE_PAGES: u32 = 1;
const OP_EXTRACT_PAGES: u32 = 2;
const OP_REORDER_PAGES: u32 = 3;
const OP_INSERT_PAGES: u32 = 4;
const OP_ROTATE: u32 = 5;
const OP_CROP: u32 = 6;
const OP_REMOVE_CROP: u32 = 7;
const OP_GET_PAGE_GEOMETRY: u32 = 8;

const RESPONSE_MUTATION: u32 = 1;
const RESPONSE_GEOMETRY: u32 = 2;
const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;

thread_local! {
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct ParsedRequest<'a> {
    operation: u32,
    pages: Vec<u32>,
    page_number: u32,
    after_page: u32,
    angle: i64,
    margins: CropMargins,
    data: &'a [u8],
    insertion_data: &'a [u8],
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_alloc(len: usize) -> *mut u8 {
    if !allocation_length_is_admitted(len, MAX_REQUEST_BYTES) {
        return std::ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::new();
    if buffer.try_reserve_exact(len).is_err() {
        return std::ptr::null_mut();
    }
    let pointer = buffer.as_mut_ptr();
    mem::forget(buffer);
    pointer
}

fn allocation_length_is_admitted(len: usize, max_bytes: usize) -> bool {
    len > 0 && len <= max_bytes
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_page_ops_free(pointer: *mut u8, capacity: usize) {
    if !pointer.is_null() {
        drop(Vec::from_raw_parts(pointer, 0, capacity));
    }
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_page_ops_run(
    request_pointer: *const u8,
    request_len: usize,
) -> i32 {
    clear_last_result();
    if request_pointer.is_null() || request_len == 0 || request_len > MAX_REQUEST_BYTES {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::TooLarge,
            message: "Page-op WASM request exceeds the admission ceiling".to_string(),
        });
        return -1;
    }
    let request = slice::from_raw_parts(request_pointer, request_len);
    match std::panic::catch_unwind(|| run_request(request)) {
        Ok(Ok(output)) if output.len() <= PAGE_OP_WASM_MAX_OUTPUT_BYTES => {
            LAST_OUTPUT.with(|slot| {
                *slot.borrow_mut() = output;
            });
            0
        }
        Ok(Ok(_)) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::TooLarge,
                message: "Page-op WASM output exceeds the admission ceiling".to_string(),
            });
            -1
        }
        Ok(Err(error)) => {
            set_error_envelope(NativeErrorEnvelope::from_error(error.as_ref()));
            -1
        }
        Err(_) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::Panic,
                message: "Native page operation panicked".to_string(),
            });
            -1
        }
    }
}

fn set_last_error(message: &str) {
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = message.as_bytes().to_vec();
    });
}

fn set_error_envelope(envelope: NativeErrorEnvelope) {
    set_last_error(&envelope.to_json());
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_output_ptr() -> *const u8 {
    LAST_OUTPUT.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_output_len() -> usize {
    LAST_OUTPUT.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

fn clear_last_result() {
    LAST_OUTPUT.with(|slot| slot.borrow_mut().clear());
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn run_request(request: &[u8]) -> Result<Vec<u8>> {
    let parsed = parse_request(request)?;
    match parsed.operation {
        OP_DELETE_PAGES => encode_mutation(delete_browser_pdf_pages(parsed.data, &parsed.pages)?),
        OP_EXTRACT_PAGES => encode_mutation(extract_browser_pdf_pages(parsed.data, &parsed.pages)?),
        OP_REORDER_PAGES => encode_mutation(reorder_browser_pdf_pages(parsed.data, &parsed.pages)?),
        OP_INSERT_PAGES => encode_mutation(insert_browser_pdf_pages(
            parsed.data,
            parsed.insertion_data,
            parsed.after_page,
        )?),
        OP_ROTATE => encode_mutation(rotate_browser_pdf_bytes(
            parsed.data,
            &parsed.pages,
            parsed.angle,
        )?),
        OP_CROP => encode_mutation(crop_browser_pdf_bytes(
            parsed.data,
            &parsed.pages,
            parsed.margins,
        )?),
        OP_REMOVE_CROP => {
            encode_mutation(remove_crop_browser_pdf_bytes(parsed.data, &parsed.pages)?)
        }
        OP_GET_PAGE_GEOMETRY => encode_geometry(get_browser_page_geometry_from_bytes(
            parsed.data,
            parsed.page_number,
        )?),
        _ => Err(format!(
            "Unsupported browser page-op WASM operation {}",
            parsed.operation
        )
        .into()),
    }
}

fn parse_request(request: &[u8]) -> Result<ParsedRequest<'_>> {
    let mut offset = 0usize;
    let magic = take_bytes(request, &mut offset, REQUEST_MAGIC.len())?;
    if magic != REQUEST_MAGIC {
        return Err("Invalid page-op WASM request magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if version != REQUEST_VERSION {
        return Err(format!("Unsupported page-op WASM request version: {version}").into());
    }

    let operation = read_u32_le(request, &mut offset)?;
    let page_count = read_usize_le(request, &mut offset, "page_count")?;
    let page_number = read_u32_le(request, &mut offset)?;
    let after_page = read_u32_le(request, &mut offset)?;
    let angle = i64::from(read_u32_le(request, &mut offset)?);
    let margins = CropMargins {
        top: read_f64_le(request, &mut offset)?,
        bottom: read_f64_le(request, &mut offset)?,
        left: read_f64_le(request, &mut offset)?,
        right: read_f64_le(request, &mut offset)?,
    };
    let data_len = read_usize_le(request, &mut offset, "data_len")?;
    let insertion_data_len = read_usize_le(request, &mut offset, "insertion_data_len")?;

    let page_bytes_len = page_count
        .checked_mul(std::mem::size_of::<u32>())
        .ok_or("Invalid page-op WASM page count")?;
    let required_remaining = page_bytes_len
        .checked_add(data_len)
        .and_then(|length| length.checked_add(insertion_data_len))
        .ok_or("Invalid page-op WASM request length")?;
    let actual_remaining = request
        .len()
        .checked_sub(offset)
        .ok_or("Invalid page-op WASM request length")?;
    if required_remaining != actual_remaining {
        return Err(if required_remaining > actual_remaining {
            "Truncated page-op WASM request"
        } else {
            "Trailing bytes in page-op WASM request"
        }
        .into());
    }

    let mut pages = Vec::new();
    pages
        .try_reserve_exact(page_count)
        .map_err(|_| "Page-op WASM page list is too large")?;
    for _ in 0..page_count {
        pages.push(read_u32_le(request, &mut offset)?);
    }

    let data = take_bytes(request, &mut offset, data_len)?;
    let insertion_data = take_bytes(request, &mut offset, insertion_data_len)?;
    if offset != request.len() {
        return Err("Trailing bytes in page-op WASM request".into());
    }

    Ok(ParsedRequest {
        operation,
        pages,
        page_number,
        after_page,
        angle,
        margins,
        data,
        insertion_data,
    })
}

fn encode_mutation(result: PageMutationBytes) -> Result<Vec<u8>> {
    encode_mutation_with_limit(result, PAGE_OP_WASM_MAX_OUTPUT_BYTES)
}

fn mutation_frame_len(data_len: usize, max_output_bytes: usize) -> Result<usize> {
    let framed_len = PAGE_OP_WASM_MUTATION_HEADER_BYTES
        .checked_add(data_len)
        .ok_or_else(page_op_output_limit)?;
    if framed_len > max_output_bytes {
        return Err(page_op_output_limit());
    }
    Ok(framed_len)
}

fn page_op_output_limit() -> Box<dyn std::error::Error> {
    Box::new(evb_native_support::NativeError::new(
        NativeErrorCode::TooLarge,
        "Page-op WASM output exceeds the admission ceiling",
    ))
}

fn encode_mutation_with_limit(
    mut result: PageMutationBytes,
    max_output_bytes: usize,
) -> Result<Vec<u8>> {
    let data_len = u32::try_from(result.data.len()).map_err(|_| page_op_output_limit())?;
    let raw_len = result.data.len();
    let framed_len = mutation_frame_len(raw_len, max_output_bytes)?;
    result
        .data
        .try_reserve_exact(PAGE_OP_WASM_MUTATION_HEADER_BYTES)
        .map_err(|_| page_op_output_limit())?;
    result.data.resize(framed_len, 0);
    result
        .data
        .copy_within(0..raw_len, PAGE_OP_WASM_MUTATION_HEADER_BYTES);
    result.data[0..4].copy_from_slice(&RESPONSE_MUTATION.to_le_bytes());
    result.data[4..8].copy_from_slice(&result.page_count.to_le_bytes());
    result.data[8..12].copy_from_slice(&data_len.to_le_bytes());
    Ok(result.data)
}

fn encode_geometry(geometry: PageGeometry) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(84);
    write_u32_le(&mut output, RESPONSE_GEOMETRY);
    write_u32_le(&mut output, u32::try_from(geometry.rotation)?);
    write_rect(&mut output, geometry.media_box);
    match geometry.crop_box {
        Some(crop_box) => {
            write_u32_le(&mut output, 1);
            write_rect(&mut output, crop_box);
        }
        None => {
            write_u32_le(&mut output, 0);
            write_rect(
                &mut output,
                PdfRect {
                    x1: 0.0,
                    y1: 0.0,
                    x2: 0.0,
                    y2: 0.0,
                },
            );
        }
    }
    Ok(output)
}

fn write_rect(output: &mut Vec<u8>, rect: PdfRect) {
    write_f64_le(output, rect.x1);
    write_f64_le(output, rect.y1);
    write_f64_le(output, rect.width());
    write_f64_le(output, rect.height());
}

fn read_usize_le(request: &[u8], offset: &mut usize, label: &str) -> Result<usize> {
    usize::try_from(read_u32_le(request, offset)?)
        .map_err(|_| format!("Invalid page-op WASM {label}").into())
}

fn read_u32_le(request: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = take_bytes(request, offset, 4)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_f64_le(request: &[u8], offset: &mut usize) -> Result<f64> {
    let bytes = take_bytes(request, offset, 8)?;
    Ok(f64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn take_bytes<'a>(request: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or("Invalid page-op WASM request length")?;
    let bytes = request
        .get(*offset..end)
        .ok_or("Truncated page-op WASM request")?;
    *offset = end;
    Ok(bytes)
}

fn write_u32_le(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_f64_le(output: &mut Vec<u8>, value: f64) {
    output.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object};

    fn request_header(page_count: u32, data_len: u32, insertion_data_len: u32) -> Vec<u8> {
        let mut request = Vec::new();
        request.extend_from_slice(REQUEST_MAGIC);
        for value in [REQUEST_VERSION, OP_DELETE_PAGES, page_count, 0, 0, 0] {
            write_u32_le(&mut request, value);
        }
        for _ in 0..4 {
            write_f64_le(&mut request, 0.0);
        }
        write_u32_le(&mut request, data_len);
        write_u32_le(&mut request, insertion_data_len);
        request
    }

    fn test_pdf_bytes() -> Vec<u8> {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).expect("serialize test PDF");
        bytes
    }

    fn crop_request(data: &[u8], top: f64) -> Vec<u8> {
        let mut request = Vec::new();
        request.extend_from_slice(REQUEST_MAGIC);
        for value in [REQUEST_VERSION, OP_CROP, 1, 0, 0, 0] {
            write_u32_le(&mut request, value);
        }
        for value in [top, 0.0, 0.0, 0.0] {
            write_f64_le(&mut request, value);
        }
        write_u32_le(&mut request, data.len() as u32);
        write_u32_le(&mut request, 0);
        write_u32_le(&mut request, 1);
        request.extend_from_slice(data);
        request
    }

    fn assert_too_large(error: Box<dyn std::error::Error>) {
        assert_eq!(
            error
                .downcast_ref::<evb_native_support::NativeError>()
                .unwrap()
                .code,
            NativeErrorCode::TooLarge
        );
    }

    #[test]
    fn allocator_admits_only_nonzero_lengths_at_or_below_the_cap() {
        assert!(!allocation_length_is_admitted(0, 8));
        assert!(allocation_length_is_admitted(8, 8));
        assert!(!allocation_length_is_admitted(9, 8));
        assert!(evb_pdf_page_ops_alloc(0).is_null());
        assert!(evb_pdf_page_ops_alloc(MAX_REQUEST_BYTES + 1).is_null());
    }

    #[test]
    fn mutation_framing_checks_exact_limits_and_arithmetic_overflow() {
        let framed = encode_mutation_with_limit(
            PageMutationBytes {
                data: vec![1, 2, 3, 4],
                page_count: 2,
            },
            16,
        )
        .unwrap();
        assert_eq!(framed.len(), 16);
        assert_eq!(&framed[0..4], &RESPONSE_MUTATION.to_le_bytes());
        assert_eq!(&framed[4..8], &2u32.to_le_bytes());
        assert_eq!(&framed[8..12], &4u32.to_le_bytes());
        assert_eq!(&framed[12..], &[1, 2, 3, 4]);

        assert_too_large(
            encode_mutation_with_limit(
                PageMutationBytes {
                    data: vec![0; 5],
                    page_count: 1,
                },
                16,
            )
            .unwrap_err(),
        );
        assert_too_large(mutation_frame_len(usize::MAX, usize::MAX).unwrap_err());
    }

    #[test]
    fn document_writer_stops_at_the_output_cap_with_a_typed_error() {
        let mut document = Document::load_mem(&test_pdf_bytes()).unwrap();
        let error = crate::save_document_to_bytes_with_limit(&mut document, 16).unwrap_err();
        assert_too_large(error);
    }

    #[test]
    fn run_rejects_oversized_lengths_before_reading_the_pointer() {
        let dangling = std::ptr::NonNull::<u8>::dangling().as_ptr();
        let status = unsafe { evb_pdf_page_ops_run(dangling, MAX_REQUEST_BYTES + 1) };
        assert_eq!(status, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"too-large","message":"Page-op WASM request exceeds the admission ceiling"}"#
        );
    }

    #[test]
    fn rejects_page_count_that_exceeds_remaining_records_before_reserving() {
        let request = request_header(u32::MAX, 0, 0);

        let error = parse_request(&request)
            .err()
            .expect("oversized page count must fail");

        assert!(error.to_string().contains("Truncated page-op WASM request"));
    }

    #[test]
    fn rejects_combined_record_lengths_that_exceed_remaining_bytes() {
        let mut request = request_header(1, u32::MAX, u32::MAX);
        write_u32_le(&mut request, 1);

        let error = parse_request(&request)
            .err()
            .expect("oversized payload lengths must fail");

        assert!(error.to_string().contains("Truncated page-op WASM request"));
    }

    #[test]
    fn rejects_trailing_bytes_before_allocating_page_records() {
        let mut request = request_header(0, 0, 0);
        request.push(0);

        let error = parse_request(&request)
            .err()
            .expect("trailing bytes must fail");

        assert!(error.to_string().contains("Trailing bytes"));
    }

    #[test]
    fn wasm_crop_rejects_non_finite_margins_through_shared_validation() {
        let request = crop_request(&test_pdf_bytes(), f64::NAN);

        let error = run_request(&request)
            .expect_err("WASM crop must reject non-finite margins through shared validation");

        assert!(error.to_string().contains("Invalid top crop margin"));
    }
}
