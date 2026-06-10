use std::{cell::RefCell, mem, slice};

use crate::{
    crop_browser_pdf_bytes, delete_browser_pdf_pages, extract_browser_pdf_pages,
    get_browser_page_geometry_from_bytes, insert_browser_pdf_pages, remove_crop_browser_pdf_bytes,
    reorder_browser_pdf_pages, rotate_browser_pdf_bytes, CropMargins, PageGeometry,
    PageMutationBytes, PdfRect, Result,
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
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    mem::forget(buffer);
    pointer
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
    let request = slice::from_raw_parts(request_pointer, request_len);
    match run_request(request) {
        Ok(output) => {
            LAST_OUTPUT.with(|slot| {
                *slot.borrow_mut() = output;
            });
            0
        }
        Err(error) => {
            LAST_ERROR.with(|slot| {
                *slot.borrow_mut() = error.to_string().into_bytes();
            });
            -1
        }
    }
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

    let mut pages = Vec::with_capacity(page_count);
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
    let data_len = u32::try_from(result.data.len())
        .map_err(|_| "Page-op WASM mutation output is too large")?;
    let mut output = Vec::with_capacity(12 + result.data.len());
    write_u32_le(&mut output, RESPONSE_MUTATION);
    write_u32_le(&mut output, result.page_count);
    write_u32_le(&mut output, data_len);
    output.extend_from_slice(&result.data);
    Ok(output)
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
