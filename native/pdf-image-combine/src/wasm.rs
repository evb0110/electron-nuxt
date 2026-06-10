use std::{cell::RefCell, mem, slice, str};

use crate::{
    build_pdf_from_image_bytes_inputs,
    ImageBytesInput,
    PdfBuildOptions,
    Result,
};

const REQUEST_MAGIC: &[u8; 4] = b"EPIC";
const REQUEST_VERSION: u32 = 1;

thread_local! {
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct ParsedRequest<'a> {
    inputs: Vec<ImageBytesInput<'a>>,
    options: PdfBuildOptions,
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    mem::forget(buffer);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_image_combine_free(pointer: *mut u8, capacity: usize) {
    if !pointer.is_null() {
        drop(Vec::from_raw_parts(pointer, 0, capacity));
    }
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_image_combine_build_pdf(
    request_pointer: *const u8,
    request_len: usize,
) -> i32 {
    clear_last_result();
    let request = slice::from_raw_parts(request_pointer, request_len);
    match build_pdf_from_request(request) {
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
pub extern "C" fn evb_pdf_image_combine_output_ptr() -> *const u8 {
    LAST_OUTPUT.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_output_len() -> usize {
    LAST_OUTPUT.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

fn clear_last_result() {
    LAST_OUTPUT.with(|slot| slot.borrow_mut().clear());
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn build_pdf_from_request(request: &[u8]) -> Result<Vec<u8>> {
    let parsed = parse_request(request)?;
    build_pdf_from_image_bytes_inputs(&parsed.inputs, &parsed.options)
}

fn parse_request(request: &[u8]) -> Result<ParsedRequest<'_>> {
    let mut offset = 0usize;
    let magic = take_bytes(request, &mut offset, REQUEST_MAGIC.len())?;
    if magic != REQUEST_MAGIC {
        return Err("Invalid image-combine WASM request magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if version != REQUEST_VERSION {
        return Err(format!("Unsupported image-combine WASM request version: {version}").into());
    }

    let default_dpi = match read_u32_le(request, &mut offset)? {
        0 => None,
        value => Some(value),
    };
    let options = PdfBuildOptions {
        default_dpi,
        max_pages: read_usize_le(request, &mut offset, "max_pages")?,
        max_pixels: u64::from(read_u32_le(request, &mut offset)?),
        max_tiff_frames: read_usize_le(request, &mut offset, "max_tiff_frames")?,
    };
    let input_count = read_usize_le(request, &mut offset, "input_count")?;
    if input_count == 0 {
        return Err("At least one image input is required".into());
    }

    let mut inputs = Vec::with_capacity(input_count);
    for _ in 0..input_count {
        let name_len = read_usize_le(request, &mut offset, "name_len")?;
        let data_len = read_usize_le(request, &mut offset, "data_len")?;
        let name = str::from_utf8(take_bytes(request, &mut offset, name_len)?)?;
        let data = take_bytes(request, &mut offset, data_len)?;
        inputs.push(ImageBytesInput {
            file_name: name,
            data,
        });
    }

    if offset != request.len() {
        return Err("Trailing bytes in image-combine WASM request".into());
    }

    Ok(ParsedRequest { inputs, options })
}

fn read_usize_le(request: &[u8], offset: &mut usize, label: &str) -> Result<usize> {
    usize::try_from(read_u32_le(request, offset)?)
        .map_err(|_| format!("Invalid image-combine WASM {label}").into())
}

fn read_u32_le(request: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = take_bytes(request, offset, 4)?;
    Ok(u32::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3],
    ]))
}

fn take_bytes<'a>(request: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or("Invalid image-combine WASM request length")?;
    let bytes = request
        .get(*offset..end)
        .ok_or("Truncated image-combine WASM request")?;
    *offset = end;
    Ok(bytes)
}
