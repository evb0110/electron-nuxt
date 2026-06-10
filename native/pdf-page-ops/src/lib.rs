#![allow(dead_code)]

mod page_sizes;

use lopdf::{
    dictionary, Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat,
};
use page_sizes::write_page_sizes_json;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    env,
    error::Error,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

include!("types.rs");
include!("cli.rs");
include!("input.rs");
include!("dispatcher.rs");
include!("incremental.rs");
include!("postconditions.rs");
include!("annotations.rs");
include!("placed_images.rs");
include!("catalog.rs");
include!("shapes.rs");
include!("markup_hints.rs");
include!("markup.rs");
include!("page_geometry.rs");
include!("page_tree_ops.rs");

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
mod wasm;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> std::result::Result<(), getrandom::Error> {
    if dest.is_null() && len > 0 {
        return Err(getrandom::Error::new_custom(1));
    }

    std::slice::from_raw_parts_mut(dest, len).fill(0);
    Ok(())
}
