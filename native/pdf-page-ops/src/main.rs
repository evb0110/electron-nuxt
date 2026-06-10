mod page_sizes;

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
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
include!("catalog.rs");
include!("shapes.rs");
include!("markup_hints.rs");
include!("markup.rs");
include!("page_geometry.rs");

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
    include!("tests/markup_shapes.rs");
    include!("tests/catalog.rs");
}
