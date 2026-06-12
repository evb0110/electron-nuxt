

function normalizeEditorIdToken(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    const raw = String(value).trim();
    if (!raw) {
        return null;
    }

    const lower = raw.toLowerCase();
    const nestedEditorIdentity = lower.match(/^editor:\d+:(.+)$/);
    if (nestedEditorIdentity?.[1]) {
        const nested = normalizeEditorIdToken(nestedEditorIdentity[1]);
        return nested ?? nestedEditorIdentity[1];
    }

    const pdfjsInternalEditor = lower.match(/^pdfjs_internal_editor_(\d+)$/);
    if (pdfjsInternalEditor?.[1]) {
        return `editor#${pdfjsInternalEditor[1]}`;
    }

    const compactEditor = lower.match(/^editor[_:-]?(\d+)$/);
    if (compactEditor?.[1]) {
        return `editor#${compactEditor[1]}`;
    }

    if (/^\d+$/.test(lower)) {
        return `editor#${lower}`;
    }

    return lower;
}

export function editorIdsLikelyMatch(
    left: string | number | null | undefined,
    right: string | number | null | undefined,
) {
    const leftRaw = typeof left === 'string' || typeof left === 'number'
        ? String(left)
        : null;
    const rightRaw = typeof right === 'string' || typeof right === 'number'
        ? String(right)
        : null;
    if (!leftRaw || !rightRaw) {
        return false;
    }
    if (leftRaw === rightRaw) {
        return true;
    }

    const leftNormalized = normalizeEditorIdToken(leftRaw);
    const rightNormalized = normalizeEditorIdToken(rightRaw);
    return Boolean(
        leftNormalized
        && rightNormalized
        && leftNormalized === rightNormalized,
    );
}
