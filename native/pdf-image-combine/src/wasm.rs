use evb_native_support::{NativeErrorCode, NativeErrorEnvelope};
use std::{cell::RefCell, mem, slice, str};

use crate::{
    build_mixed_pdf_from_bytes_page_specs, build_pdf_from_image_bytes_page_inputs, ImageBytesInput,
    ImageBytesPageInput, MixedPdfBytesPageSpec, MixedPdfImageCompression, MixedPdfImageProcessing,
    PdfBuildOptions, PdfPageSize, Result,
};

const REQUEST_MAGIC: &[u8; 4] = b"EPIC";
const REQUEST_VERSION_V1: u32 = 1;
const REQUEST_VERSION_V2: u32 = 2;
const REQUEST_VERSION_V3: u32 = 3;
const REQUEST_VERSION_V4: u32 = 4;
const PAGE_KIND_IMAGE: u32 = 1;
const PAGE_KIND_MASK: u32 = 2;
const PAGE_KIND_LAYERED: u32 = 3;
const PAGE_KIND_LAYERED_COLOR: u32 = 4;
const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;

thread_local! {
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

enum ParsedRequest<'a> {
    ImageInputs {
        inputs: Vec<ImageBytesPageInput<'a>>,
        options: PdfBuildOptions,
    },
    PageSpecs {
        page_specs: Vec<MixedPdfBytesPageSpec<'a>>,
        options: PdfBuildOptions,
    },
}

struct RequestHeader {
    options: PdfBuildOptions,
    item_count: usize,
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::new();
    if buffer.try_reserve_exact(len).is_err() {
        return std::ptr::null_mut();
    }
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
    if request_pointer.is_null() || request_len == 0 || request_len > MAX_REQUEST_BYTES {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::TooLarge,
            message: "Image-combine WASM request exceeds the admission ceiling".to_string(),
        });
        return -1;
    }
    let request = slice::from_raw_parts(request_pointer, request_len);
    match std::panic::catch_unwind(|| build_pdf_from_request(request)) {
        Ok(Ok(output)) if output.len() <= MAX_OUTPUT_BYTES => {
            LAST_OUTPUT.with(|slot| {
                *slot.borrow_mut() = output;
            });
            0
        }
        Ok(Ok(_)) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::TooLarge,
                message: "Image-combine WASM output exceeds the admission ceiling".to_string(),
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
                message: "Native image combine panicked".to_string(),
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
    match parsed {
        ParsedRequest::ImageInputs { inputs, options } => {
            build_pdf_from_image_bytes_page_inputs(&inputs, &options)
        }
        ParsedRequest::PageSpecs {
            page_specs,
            options,
        } => build_mixed_pdf_from_bytes_page_specs(&page_specs, &options),
    }
}

fn parse_request(request: &[u8]) -> Result<ParsedRequest<'_>> {
    let mut offset = 0usize;
    let magic = take_bytes(request, &mut offset, REQUEST_MAGIC.len())?;
    if magic != REQUEST_MAGIC {
        return Err("Invalid image-combine WASM request magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if version != REQUEST_VERSION_V1
        && version != REQUEST_VERSION_V2
        && version != REQUEST_VERSION_V3
        && version != REQUEST_VERSION_V4
    {
        return Err(format!("Unsupported image-combine WASM request version: {version}").into());
    }

    let header = parse_request_header(request, &mut offset)?;
    let parsed = if version == REQUEST_VERSION_V3 || version == REQUEST_VERSION_V4 {
        ParsedRequest::PageSpecs {
            page_specs: parse_v3_v4_page_specs(request, &mut offset, header.item_count, version)?,
            options: header.options,
        }
    } else {
        ParsedRequest::ImageInputs {
            inputs: parse_v1_v2_image_inputs(request, &mut offset, header.item_count, version)?,
            options: header.options,
        }
    };

    if offset != request.len() {
        return Err("Trailing bytes in image-combine WASM request".into());
    }

    Ok(parsed)
}

fn parse_request_header(request: &[u8], offset: &mut usize) -> Result<RequestHeader> {
    let default_dpi = match read_u32_le(request, offset)? {
        0 => None,
        value => Some(value),
    };
    let options = PdfBuildOptions {
        default_dpi,
        max_pages: read_usize_le(request, offset, "max_pages")?,
        max_pixels: u64::from(read_u32_le(request, offset)?),
        max_tiff_frames: read_usize_le(request, offset, "max_tiff_frames")?,
    };
    let item_count = read_usize_le(request, offset, "item_count")?;
    if item_count == 0 {
        return Err("At least one image input is required".into());
    }
    Ok(RequestHeader {
        options,
        item_count,
    })
}

fn parse_v1_v2_image_inputs<'a>(
    request: &'a [u8],
    offset: &mut usize,
    input_count: usize,
    version: u32,
) -> Result<Vec<ImageBytesPageInput<'a>>> {
    let mut inputs = Vec::with_capacity(input_count);
    for _ in 0..input_count {
        let mut compression = MixedPdfImageCompression::Auto;
        let mut image_processing = MixedPdfImageProcessing::None;
        let mut page_size = None;
        if version == REQUEST_VERSION_V2 {
            let target_ppi = read_u16_range(request, offset, "target_ppi", 0, 600)?;
            let max_scale = read_u8_range(request, offset, "max_scale", 1, 4)?;
            let dark_speckle_area = read_u16_range(request, offset, "dark_speckle_area", 0, 256)?;
            let jpeg_quality = read_u8_range(request, offset, "jpeg_quality", 0, 100)?;
            let width_points = read_f64_le(request, offset)?;
            let height_points = read_f64_le(request, offset)?;
            if width_points != 0.0 || height_points != 0.0 {
                if !width_points.is_finite()
                    || !height_points.is_finite()
                    || width_points <= 0.0
                    || height_points <= 0.0
                {
                    return Err("Invalid image-combine WASM page size".into());
                }
                page_size = Some(PdfPageSize {
                    width_points,
                    height_points,
                });
            }
            if jpeg_quality > 0 {
                compression = MixedPdfImageCompression::Jpeg {
                    quality: jpeg_quality,
                };
            }
            if target_ppi > 0 || dark_speckle_area > 0 {
                if jpeg_quality == 0 {
                    return Err("WASM image preprocessing requires JPEG quality".into());
                }
                let _ = max_scale;
                let _ = dark_speckle_area;
                image_processing = MixedPdfImageProcessing::DownscaleToPpi {
                    ppi_cap: target_ppi.max(1),
                };
            }
        }
        let input = read_image_bytes_input(request, offset)?;
        inputs.push(ImageBytesPageInput {
            file_name: input.file_name,
            data: input.data,
            page_size,
            compression,
            image_processing,
            size_guardrail: None,
        });
    }
    Ok(inputs)
}

fn parse_v3_v4_page_specs<'a>(
    request: &'a [u8],
    offset: &mut usize,
    page_count: usize,
    version: u32,
) -> Result<Vec<MixedPdfBytesPageSpec<'a>>> {
    let mut page_specs = Vec::with_capacity(page_count);
    for _ in 0..page_count {
        let kind = read_u32_le(request, offset)?;
        let page_size = read_page_size(request, offset)?;
        let jpeg_quality = read_u8_range(request, offset, "jpeg_quality", 0, 100)?;
        let ppi_cap = read_u16_range(request, offset, "ppi_cap", 0, 1200)?;
        if version == REQUEST_VERSION_V3 {
            let _ = read_u32_le(request, offset)?;
        }
        let compression = if jpeg_quality > 0 {
            MixedPdfImageCompression::Jpeg {
                quality: jpeg_quality,
            }
        } else {
            MixedPdfImageCompression::Auto
        };
        let image_processing = if ppi_cap > 0 {
            MixedPdfImageProcessing::DownscaleToPpi { ppi_cap }
        } else {
            MixedPdfImageProcessing::None
        };

        let page_spec = match kind {
            PAGE_KIND_IMAGE => MixedPdfBytesPageSpec::FullImage {
                page_size,
                image: read_image_bytes_input(request, offset)?,
                compression,
                image_processing,
                size_guardrail: ppi_cap > 0,
            },
            PAGE_KIND_MASK => MixedPdfBytesPageSpec::MaskOnly {
                page_size,
                foreground_mask: read_image_bytes_input(request, offset)?,
            },
            PAGE_KIND_LAYERED => MixedPdfBytesPageSpec::Layered {
                page_size,
                background: read_image_bytes_input(request, offset)?,
                foreground_mask: read_image_bytes_input(request, offset)?,
                foreground_color: None,
                background_compression: compression,
                background_processing: MixedPdfImageProcessing::None,
                size_guardrail: false,
            },
            PAGE_KIND_LAYERED_COLOR => MixedPdfBytesPageSpec::Layered {
                page_size,
                background: read_image_bytes_input(request, offset)?,
                foreground_mask: read_image_bytes_input(request, offset)?,
                foreground_color: if version == REQUEST_VERSION_V3 {
                    let _ = read_image_bytes_input(request, offset)?;
                    None
                } else {
                    Some([
                        read_u8_range(request, offset, "foreground_red", 0, 255)?,
                        read_u8_range(request, offset, "foreground_green", 0, 255)?,
                        read_u8_range(request, offset, "foreground_blue", 0, 255)?,
                    ])
                },
                background_compression: compression,
                background_processing: MixedPdfImageProcessing::None,
                size_guardrail: false,
            },
            _ => return Err(format!("Unsupported image-combine WASM page kind: {kind}").into()),
        };
        page_specs.push(page_spec);
    }
    Ok(page_specs)
}

fn read_page_size(request: &[u8], offset: &mut usize) -> Result<PdfPageSize> {
    let width_points = read_f64_le(request, offset)?;
    let height_points = read_f64_le(request, offset)?;
    if !width_points.is_finite()
        || !height_points.is_finite()
        || width_points <= 0.0
        || height_points <= 0.0
    {
        return Err("Invalid image-combine WASM page size".into());
    }
    Ok(PdfPageSize {
        width_points,
        height_points,
    })
}

fn read_image_bytes_input<'a>(
    request: &'a [u8],
    offset: &mut usize,
) -> Result<ImageBytesInput<'a>> {
    let name_len = read_usize_le(request, offset, "name_len")?;
    let data_len = read_usize_le(request, offset, "data_len")?;
    let name = str::from_utf8(take_bytes(request, offset, name_len)?)?;
    let data = take_bytes(request, offset, data_len)?;
    Ok(ImageBytesInput {
        file_name: name,
        data,
    })
}

fn read_usize_le(request: &[u8], offset: &mut usize, label: &str) -> Result<usize> {
    usize::try_from(read_u32_le(request, offset)?)
        .map_err(|_| format!("Invalid image-combine WASM {label}").into())
}

fn read_u16_range(
    request: &[u8],
    offset: &mut usize,
    label: &str,
    min_value: u16,
    max_value: u16,
) -> Result<u16> {
    let value = read_u32_le(request, offset)?;
    if value > u16::MAX as u32 {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    let parsed = value as u16;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    Ok(parsed)
}

fn read_u8_range(
    request: &[u8],
    offset: &mut usize,
    label: &str,
    min_value: u8,
    max_value: u8,
) -> Result<u8> {
    let value = read_u32_le(request, offset)?;
    if value > u8::MAX as u32 {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    let parsed = value as u8;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    Ok(parsed)
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
        .ok_or("Invalid image-combine WASM request length")?;
    let bytes = request
        .get(*offset..end)
        .ok_or("Truncated image-combine WASM request")?;
    *offset = end;
    Ok(bytes)
}
