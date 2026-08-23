/**
 * Approximate retained-heap accounting for structured-cloned annotation
 * snapshots.
 *
 * The module-global snapshot LRU has to stay inside a byte budget, and the
 * only honest way to price an entry is to look at what it holds. Serializing
 * the payload to JSON just to read `.length` would allocate a second copy of
 * the very thing we are trying to bound, so this walks the value instead and
 * sums per-slot estimates. The numbers below are deliberately coarse: they
 * model V8-ish object/array headers and UTF-16 string storage, and they only
 * need to be consistent across snapshots for eviction ordering to be sane.
 */

const OBJECT_HEADER_BYTES = 32;
const PROPERTY_SLOT_BYTES = 8;
const STRING_HEADER_BYTES = 16;
const PRIMITIVE_BYTES = 8;
const BIGINT_BYTES = 16;
const DATE_BYTES = 16;
const COLLECTION_HEADER_BYTES = 48;
const BINARY_HEADER_BYTES = 32;

// Annotation summaries and link records are flat by construction. The ceiling
// exists so a surprising deeply nested payload degrades into an underestimate
// rather than a recursion deep enough to exhaust the stack.
const MAX_ESTIMATE_DEPTH = 12;

/**
 * Price each object exactly once per walk.
 *
 * The depth guard alone bounds how deep the walk goes, not how wide: a value
 * that refers back to an ancestor is re-entered through every property that
 * points at it, so a payload with a handful of cyclic slots costs
 * fan-out^depth visits — seconds of blocked main thread, and a total inflated
 * far past the real retained bytes, which would then reject a perfectly
 * cacheable snapshot as over budget. Skipping a value already on the books
 * also matches what the number is supposed to mean: a shared object is
 * retained once, not once per reference.
 */
function estimateValueBytes(value: unknown, depth: number, seen: WeakSet<object>): number {
    if (value === null || value === undefined) {
        return PRIMITIVE_BYTES;
    }

    switch (typeof value) {
        case 'string':
            return STRING_HEADER_BYTES + (value.length * 2);
        case 'number':
        case 'boolean':
            return PRIMITIVE_BYTES;
        case 'bigint':
            return BIGINT_BYTES;
        case 'symbol':
        case 'function':
            return PRIMITIVE_BYTES;
        default:
            break;
    }

    if (depth >= MAX_ESTIMATE_DEPTH || seen.has(value)) {
        return OBJECT_HEADER_BYTES;
    }
    seen.add(value);

    if (value instanceof Date) {
        return DATE_BYTES;
    }

    if (ArrayBuffer.isView(value)) {
        return BINARY_HEADER_BYTES + value.byteLength;
    }

    if (value instanceof ArrayBuffer) {
        return BINARY_HEADER_BYTES + value.byteLength;
    }

    if (Array.isArray(value)) {
        let total = OBJECT_HEADER_BYTES;
        for (const entry of value) {
            total += PROPERTY_SLOT_BYTES + estimateValueBytes(entry, depth + 1, seen);
        }
        return total;
    }

    if (value instanceof Map) {
        let total = COLLECTION_HEADER_BYTES;
        for (const [
            key,
            entry,
        ] of value) {
            total += PROPERTY_SLOT_BYTES
                + estimateValueBytes(key, depth + 1, seen)
                + estimateValueBytes(entry, depth + 1, seen);
        }
        return total;
    }

    if (value instanceof Set) {
        let total = COLLECTION_HEADER_BYTES;
        for (const entry of value) {
            total += PROPERTY_SLOT_BYTES + estimateValueBytes(entry, depth + 1, seen);
        }
        return total;
    }

    let total = OBJECT_HEADER_BYTES;
    for (const [
        key,
        entry,
    ] of Object.entries(value as Record<string, unknown>)) {
        total += PROPERTY_SLOT_BYTES
            + (key.length * 2)
            + estimateValueBytes(entry, depth + 1, seen);
    }
    return total;
}

/**
 * Approximate bytes retained by one cached annotation snapshot payload.
 *
 * Cost is one linear walk of the comment and link records, so it is safe to
 * call on the source arrays before cloning them into the cache.
 */
export function estimateAnnotationSnapshotBytes(snapshot: {
    comments: readonly unknown[];
    links: readonly unknown[];
}): number {
    const seen = new WeakSet<object>();
    return OBJECT_HEADER_BYTES
        + estimateValueBytes(snapshot.comments, 0, seen)
        + estimateValueBytes(snapshot.links, 0, seen);
}
