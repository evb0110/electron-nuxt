

export function commentPreviewFromRawText(text: string, emptyNoteLabel: string) {
    const raw = text.trim();
    if (!raw) {
        return emptyNoteLabel;
    }
    if (raw.length > 120) {
        return `${raw.slice(0, 117)}...`;
    }
    return raw;
}
