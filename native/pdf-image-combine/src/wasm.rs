use evb_native_support::{NativeErrorCode, NativeErrorEnvelope};
use std::{cell::RefCell, mem, slice, str};

use crate::{
    write_pdf, FramePolicy, ImageCompression, ImageProcessing, ImageSpec, InputSource,
    JpegSizeGuardrail, PageSpec, PdfBuildOptions, PdfPageSize, PdfPageSpec, Result,
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
            LAST_OUTPUT.with(|slot| *slot.borrow_mut() = output);
            0
        }
        Ok(Ok(_)) => {
            set_error_envelope(output_ceiling_error());
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

fn set_error_envelope(envelope: NativeErrorEnvelope) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = envelope.to_json().into_bytes());
}
fn output_ceiling_error() -> NativeErrorEnvelope {
    NativeErrorEnvelope {
        code: NativeErrorCode::TooLarge,
        message: "Image-combine WASM output exceeds the admission ceiling".to_string(),
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
    let (page_specs, options) = parse_request(request)?;
    write_pdf(Vec::new(), page_specs, &options, |_| {})
}

fn parse_request(request: &[u8]) -> Result<(Vec<PdfPageSpec<'_>>, PdfBuildOptions)> {
    let mut offset = 0usize;
    if take_bytes(request, &mut offset, REQUEST_MAGIC.len())? != REQUEST_MAGIC {
        return Err("Invalid image-combine WASM request magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if !(REQUEST_VERSION_V1..=REQUEST_VERSION_V4).contains(&version) {
        return Err(format!("Unsupported image-combine WASM request version: {version}").into());
    }

    let header = parse_request_header(request, &mut offset)?;
    let page_specs = if version <= REQUEST_VERSION_V2 {
        parse_v1_v2_page_specs(request, &mut offset, header.item_count, version)?
    } else {
        parse_v3_v4_page_specs(request, &mut offset, header.item_count, version)?
    };
    if offset != request.len() {
        return Err("Trailing bytes in image-combine WASM request".into());
    }
    Ok((page_specs, header.options))
}

fn parse_request_header(request: &[u8], offset: &mut usize) -> Result<RequestHeader> {
    let default_dpi = match read_u32_le(request, offset)? {
        0 => None,
        value => Some(value),
    };
    let max_pages = read_usize_le(request, offset, "max_pages")?;
    let max_pixels = u64::from(read_u32_le(request, offset)?);
    let options = PdfBuildOptions {
        default_dpi,
        max_pages,
        max_pixels,
        max_bilevel_pixels: max_pixels,
        max_output_bytes: u64::MAX,
        max_tiff_frames: read_usize_le(request, offset, "max_tiff_frames")?,
        worker_threads: 1,
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

fn parse_v1_v2_page_specs<'a>(
    request: &'a [u8],
    offset: &mut usize,
    input_count: usize,
    version: u32,
) -> Result<Vec<PdfPageSpec<'a>>> {
    let mut page_specs = Vec::with_capacity(input_count);
    for _ in 0..input_count {
        let mut compression = ImageCompression::Auto;
        let mut processing = ImageProcessing::None;
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
                compression = ImageCompression::Jpeg {
                    quality: jpeg_quality,
                };
            }
            if target_ppi > 0 || dark_speckle_area > 0 {
                if jpeg_quality == 0 {
                    return Err("WASM image preprocessing requires JPEG quality".into());
                }
                let _ = max_scale;
                let _ = dark_speckle_area;
                processing = ImageProcessing::DownscaleToPpi {
                    ppi_cap: target_ppi.max(1),
                };
            }
        }
        page_specs.push(PageSpec::Image {
            page_size,
            image: ImageSpec {
                source: read_input_source(request, offset)?,
                compression,
                processing,
                size_guardrail: None,
            },
            frames: FramePolicy::All,
        });
    }
    Ok(page_specs)
}

fn parse_v3_v4_page_specs<'a>(
    request: &'a [u8],
    offset: &mut usize,
    page_count: usize,
    version: u32,
) -> Result<Vec<PdfPageSpec<'a>>> {
    let mut page_specs = Vec::with_capacity(page_count);
    for page_index in 0..page_count {
        let kind = read_u32_le(request, offset)?;
        let page_size = read_page_size(request, offset)?;
        let jpeg_quality = read_u8_range(request, offset, "jpeg_quality", 0, 100)?;
        let ppi_cap = read_u16_range(request, offset, "ppi_cap", 0, 1200)?;
        if version == REQUEST_VERSION_V3 {
            let _ = read_u32_le(request, offset)?;
        }
        let compression = if jpeg_quality > 0 {
            ImageCompression::Jpeg {
                quality: jpeg_quality,
            }
        } else {
            ImageCompression::Auto
        };
        let processing = if ppi_cap > 0 {
            ImageProcessing::DownscaleToPpi { ppi_cap }
        } else {
            ImageProcessing::None
        };

        page_specs.push(match kind {
            PAGE_KIND_IMAGE => PageSpec::Image {
                page_size: Some(page_size),
                image: ImageSpec {
                    source: read_input_source(request, offset)?,
                    compression,
                    processing,
                    size_guardrail: (ppi_cap > 0).then_some(JpegSizeGuardrail {
                        page: page_index + 1,
                        log_json_progress: false,
                    }),
                },
                frames: FramePolicy::ExactlyOne,
            },
            PAGE_KIND_MASK => PageSpec::Mask {
                page_size,
                foreground_mask: read_input_source(request, offset)?,
            },
            PAGE_KIND_LAYERED => PageSpec::Layered {
                page_size,
                background: ImageSpec {
                    source: read_input_source(request, offset)?,
                    compression,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground_mask: read_input_source(request, offset)?,
                foreground_color: None,
            },
            PAGE_KIND_LAYERED_COLOR => PageSpec::Layered {
                page_size,
                background: ImageSpec {
                    source: read_input_source(request, offset)?,
                    compression,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground_mask: read_input_source(request, offset)?,
                foreground_color: if version == REQUEST_VERSION_V3 {
                    let _ = read_input_source(request, offset)?;
                    None
                } else {
                    Some([
                        read_u8_range(request, offset, "foreground_red", 0, 255)?,
                        read_u8_range(request, offset, "foreground_green", 0, 255)?,
                        read_u8_range(request, offset, "foreground_blue", 0, 255)?,
                    ])
                },
            },
            _ => return Err(format!("Unsupported image-combine WASM page kind: {kind}").into()),
        });
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

fn read_input_source<'a>(request: &'a [u8], offset: &mut usize) -> Result<InputSource<'a>> {
    let name_len = read_usize_le(request, offset, "name_len")?;
    let data_len = read_usize_le(request, offset, "data_len")?;
    let file_name = str::from_utf8(take_bytes(request, offset, name_len)?)?;
    let data = take_bytes(request, offset, data_len)?;
    Ok(InputSource::Bytes { file_name, data })
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
    let parsed = u16::try_from(value).map_err(|_| format!("Invalid image-combine WASM {label}"))?;
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
    let parsed = u8::try_from(value).map_err(|_| format!("Invalid image-combine WASM {label}"))?;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    Ok(parsed)
}

fn read_u32_le(request: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = take_bytes(request, offset, 4)?;
    Ok(u32::from_le_bytes(bytes.try_into()?))
}

fn read_f64_le(request: &[u8], offset: &mut usize) -> Result<f64> {
    let bytes = take_bytes(request, offset, 8)?;
    Ok(f64::from_le_bytes(bytes.try_into()?))
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

#[cfg(test)]
mod tests {
    use super::*;

    const PPM: &[u8] = b"P6\n1 1\n255\n\x10\x20\x30";
    const PBM: &[u8] = b"P4\n8 1\n\x80";

    #[test]
    fn versions_one_through_four_map_to_page_specs_and_build() {
        let v1 = image_request(REQUEST_VERSION_V1, false);
        let (specs, options) = parse_request(&v1).unwrap();
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Image {
                frames: FramePolicy::All,
                ..
            }]
        ));
        assert!(write_pdf(Vec::new(), specs, &options, |_| {})
            .unwrap()
            .starts_with(b"%PDF-1.4"));

        let v2 = image_request(REQUEST_VERSION_V2, true);
        let (specs, options) = parse_request(&v2).unwrap();
        assert!(write_pdf(Vec::new(), specs, &options, |_| {})
            .unwrap()
            .windows(b"/DCTDecode".len())
            .any(|window| window == b"/DCTDecode"));

        let v3 = layered_color_request(REQUEST_VERSION_V3);
        let (specs, options) = parse_request(&v3).unwrap();
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Layered {
                foreground_color: None,
                ..
            }]
        ));
        assert!(write_pdf(Vec::new(), specs, &options, |_| {}).is_ok());

        let v4 = layered_color_request(REQUEST_VERSION_V4);
        let (specs, options) = parse_request(&v4).unwrap();
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Layered {
                foreground_color: Some([128, 16, 8]),
                ..
            }]
        ));
        let pdf = write_pdf(Vec::new(), specs, &options, |_| {}).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("0.5020 0.0627 0.0314 rg"));
    }

    #[test]
    fn preserves_parser_errors_and_request_ceiling_envelope() {
        let mut unsupported = request_header(99, 1);
        push_input(&mut unsupported, "page.ppm", PPM);
        assert_eq!(
            parse_request(&unsupported).err().unwrap().to_string(),
            "Unsupported image-combine WASM request version: 99"
        );

        let mut trailing = image_request(REQUEST_VERSION_V1, false);
        trailing.push(0);
        assert_eq!(
            parse_request(&trailing).err().unwrap().to_string(),
            "Trailing bytes in image-combine WASM request"
        );
        let mut truncated = image_request(REQUEST_VERSION_V1, false);
        truncated.pop();
        assert_eq!(
            parse_request(&truncated).err().unwrap().to_string(),
            "Truncated image-combine WASM request"
        );

        let dangling = std::ptr::NonNull::<u8>::dangling().as_ptr();
        let result = unsafe { evb_pdf_image_combine_build_pdf(dangling, MAX_REQUEST_BYTES + 1) };
        assert_eq!(result, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"too-large","message":"Image-combine WASM request exceeds the admission ceiling"}"#
        );
        assert_eq!(
            output_ceiling_error().to_json(),
            r#"{"code":"too-large","message":"Image-combine WASM output exceeds the admission ceiling"}"#
        );
    }

    fn image_request(version: u32, processed: bool) -> Vec<u8> {
        let mut request = request_header(version, 1);
        if version == REQUEST_VERSION_V2 {
            push_u32(&mut request, if processed { 300 } else { 0 });
            push_u32(&mut request, 1);
            push_u32(&mut request, 0);
            push_u32(&mut request, if processed { 85 } else { 0 });
            request.extend_from_slice(&72f64.to_le_bytes());
            request.extend_from_slice(&72f64.to_le_bytes());
        }
        push_input(&mut request, "page.ppm", PPM);
        request
    }

    fn layered_color_request(version: u32) -> Vec<u8> {
        let mut request = request_header(version, 1);
        push_u32(&mut request, PAGE_KIND_LAYERED_COLOR);
        request.extend_from_slice(&72f64.to_le_bytes());
        request.extend_from_slice(&72f64.to_le_bytes());
        push_u32(&mut request, 0);
        push_u32(&mut request, 0);
        if version == REQUEST_VERSION_V3 {
            push_u32(&mut request, 0xfeed_beef);
        }
        push_input(&mut request, "background.ppm", PPM);
        push_input(&mut request, "mask.pbm", PBM);
        if version == REQUEST_VERSION_V3 {
            push_input(&mut request, "legacy.pbm", b"discarded");
        } else {
            push_u32(&mut request, 128);
            push_u32(&mut request, 16);
            push_u32(&mut request, 8);
        }
        request
    }

    fn request_header(version: u32, count: u32) -> Vec<u8> {
        let mut request = REQUEST_MAGIC.to_vec();
        for value in [version, 72, 10, 1_000_000, 10, count] {
            push_u32(&mut request, value);
        }
        request
    }

    fn push_input(request: &mut Vec<u8>, name: &str, data: &[u8]) {
        push_u32(request, name.len() as u32);
        push_u32(request, data.len() as u32);
        request.extend_from_slice(name.as_bytes());
        request.extend_from_slice(data);
    }

    fn push_u32(request: &mut Vec<u8>, value: u32) {
        request.extend_from_slice(&value.to_le_bytes());
    }
}
