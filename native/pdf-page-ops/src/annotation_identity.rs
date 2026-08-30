use super::*;
use sha2::{Digest, Sha256};

/// Read the document's durable annotation name, treating an empty or
/// whitespace-only PDF string as absent.
pub(crate) fn read_annotation_name(dict: &Dictionary) -> Option<String> {
    dict.get(b"NM")
        .ok()
        .and_then(pdf_string_to_text)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// Store an annotation identity in the PDF's `/NM` string.
pub(crate) fn write_annotation_name(dict: &mut Dictionary, id: &str) {
    dict.set(
        "NM",
        Object::String(encode_pdf_text_string(id), StringFormat::Hexadecimal),
    );
}

/// Reuse a unique `/NM` value or mint a deterministic UUID-shaped identity.
///
/// The wasm build deliberately uses a zero-filling getrandom backend, so a
/// random UUID would repeat there. Hashing the page/object/subtype and request
/// timestamp gives each parse request a stable identity without adding a
/// randomness dependency. A collision suffix handles duplicate `/NM` values
/// and the otherwise possible direct-dictionary object `0R0`.
pub(crate) fn resolve_or_mint_name(
    dict: &Dictionary,
    existing_names: &HashSet<String>,
    page_index: u64,
    object_id: ObjectId,
    subtype: &str,
    modified_at: &str,
) -> String {
    if let Some(name) = read_annotation_name(dict) {
        if !existing_names.contains(&name) {
            return name;
        }
    }

    let seed = format!(
        "{page_index}:{}:{}:{subtype}:{modified_at}",
        object_id.0, object_id.1
    );
    for collision in 0_u64.. {
        let candidate = mint_uuid(&seed, collision);
        if !existing_names.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("annotation identity collision counter exhausted")
}

fn mint_uuid(seed: &str, collision: u64) -> String {
    let digest = Sha256::digest(format!("{seed}:{collision}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // UUID version 4 and RFC 4122 variant bits make the wire value familiar
    // to consumers while keeping the bytes deterministic.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_trimmed_names() {
        let mut dict = Dictionary::new();
        dict.set("NM", Object::string_literal("  name  "));
        assert_eq!(read_annotation_name(&dict).as_deref(), Some("name"));

        write_annotation_name(&mut dict, "new-name");
        assert_eq!(read_annotation_name(&dict).as_deref(), Some("new-name"));
    }

    #[test]
    fn mints_a_deterministic_uuid_for_missing_and_duplicate_names() {
        let dict = Dictionary::new();
        let empty = HashSet::new();
        let first =
            resolve_or_mint_name(&dict, &empty, 2, (17, 0), "FreeText", "D:20260830120000Z");
        assert_eq!(first.len(), 36);
        assert_eq!(first.as_bytes()[14], b'4');
        assert!(matches!(first.as_bytes()[19], b'8'..=b'b'));

        let again =
            resolve_or_mint_name(&dict, &empty, 2, (17, 0), "FreeText", "D:20260830120000Z");
        assert_eq!(first, again);

        let used = HashSet::from([first.clone()]);
        let second =
            resolve_or_mint_name(&dict, &used, 2, (17, 0), "FreeText", "D:20260830120000Z");
        assert_ne!(first, second);
    }

    #[test]
    fn keeps_the_first_occurrence_of_a_document_name() {
        let mut dict = Dictionary::new();
        dict.set("NM", Object::string_literal("foreign-name"));
        let empty = HashSet::new();
        assert_eq!(
            resolve_or_mint_name(&dict, &empty, 0, (4, 0), "Link", "D:20260830120000Z",),
            "foreign-name"
        );
        let used = HashSet::from(["foreign-name".to_string()]);
        assert_ne!(
            resolve_or_mint_name(&dict, &used, 0, (5, 0), "Link", "D:20260830120000Z",),
            "foreign-name"
        );
    }
}
