const PRESERVE_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';

const MARKUP_SUBTYPE_DRAW_CLASS_PREFIX = 'pdf-markup-subtype-draw-';

/**
 * Gate deciding which highlight SVGs participate in compositing. Only genuine
 * text `Highlight` fills qualify. Excluded:
 * - `free` — free-form (drawn) highlights, not text markup.
 * - `pdf-layer-preserve-snapshot` — frozen layer snapshots kept for paint
 *   stability; compositing them would double-draw.
 * - `pdf-markup-subtype-draw-*` — underline/strikeout/squiggly strokes, which
 *   are not fills and resolve overlap by z-order without compositing.
 */
export function shouldCompositeHighlightClassList(classNames: readonly string[]) {
    return classNames.includes('highlight')
        && !classNames.includes('free')
        && !classNames.includes(PRESERVE_SNAPSHOT_CLASS)
        && !classNames.some(className => className.startsWith(MARKUP_SUBTYPE_DRAW_CLASS_PREFIX));
}
