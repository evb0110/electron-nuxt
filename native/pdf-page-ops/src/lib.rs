mod page_sizes;

use evb_native_support::{NativeError, NativeErrorCode};
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
use lopdf::dictionary;
use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use page_sizes::write_page_sizes_json;
use serde::Deserialize;
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap, HashSet},
    env,
    error::Error,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

mod annotations;
mod catalog;
mod cli;
mod dispatcher;
mod incremental;
mod input;
mod markup;
mod markup_hints;
mod page_geometry;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
mod page_tree_ops;
mod placed_images;
mod postconditions;
mod shapes;
mod split_pages;
mod types;

pub(crate) use annotations::*;
pub(crate) use catalog::*;
pub(crate) use cli::*;
pub(crate) use dispatcher::*;
pub(crate) use incremental::*;
pub(crate) use input::*;
pub(crate) use markup::*;
pub(crate) use markup_hints::*;
pub(crate) use page_geometry::*;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) use page_tree_ops::*;
pub(crate) use placed_images::*;
pub(crate) use postconditions::*;
pub(crate) use shapes::*;
pub(crate) use split_pages::*;
pub(crate) use types::*;

pub use incremental::{fuzz_parse_incremental_xref_stream, fuzz_parse_incremental_xref_table};
pub use types::Result;

pub fn run_cli_entry() -> Result<()> {
    run()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Object};
    use std::{
        fs::{read, remove_file, write},
        time::{SystemTime, UNIX_EPOCH},
    };

    include!("tests/support.rs");
    include!("tests/crop.rs");
    include!("tests/notes.rs");
    include!("tests/placed_images.rs");
    include!("tests/markup_shapes.rs");
    include!("tests/catalog.rs");
    include!("tests/page_tree_ops.rs");
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
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
