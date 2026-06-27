import type { TAgentAssistantPresetId } from '@contracts/agent';

// Universal, edge-case-aware workflows shared by the MCP prompts (prompts/get) and the
// in-app assistant preset chips. Each workflow is a decision tree the model follows so a
// single preset button works regardless of the document's current state.

export const ASSISTANT_BOOKMARK_WORKFLOW = [
    'Build or correct PDF bookmarks for the active document, whatever its current state.',
    'Read evb://document/{tabId}/toc and /bookmarks and inspect text coverage with document.inspect_text. Treat any existing TOC/bookmarks as hints, not proof.',
    'Choose the outline source in this order: (1) a user-supplied outline if one was given; (2) the embedded TOC/bookmarks; (3) a printed contents page inside the document, located with document.search ("contents", "table of contents") and read with document.read_pages; (4) if none exist, derive the structure yourself from chapter/section starts, heading patterns, numbered headings, and running heads sampled across the document.',
    'Locate every section start with document.search and document.read_pages, and resolve the printed-number vs physical-page offset using evb://document/{tabId}/page-labels so each destination points to the correct physical page.',
    'For doubtful title/page matches, duplicated or ambiguous headings, wrong-looking offsets, or OCR gaps, call document.capture_page_image through evb_run_action on candidate pages or crops and inspect the visible page before writing. If the document has little or no searchable text, say OCR is recommended instead of guessing.',
    'Infer a sane hierarchy (parts > chapters > sections) and a reasonable depth. Call bookmarks.preview_tree through evb_read_action, inspect the normalized tree, flat path list, issues, and diff, then commit with bookmarks.apply_plan through evb_run_action. If evb_run_action reports confirmation required, denied, or unavailable, no bookmarks were changed: report the preview tree and ask for a grant or manual apply. Re-read bookmarks and save with file.save only after a verified write.',
].join('\n');

export const ASSISTANT_PAGE_NUMBER_WORKFLOW = [
    'Reconstruct the PDF page labels to match the document\'s real numbering, whatever scheme it uses.',
    'Read evb://document/{tabId}/page-labels and inspect text coverage with document.inspect_text. Use searchable/OCR text as evidence but never trust it blindly.',
    'Sample the cover, the front-matter/body transition, any appendix/plate/insert sections, and the end. Detect and combine schemes as needed: roman front matter (i, ii, iii), arabic body, restarted numbering, alphabetic or prefixed labels (A, A-1), and unnumbered covers, plates, or blanks. Determine the offset for each range by finding which physical page carries each printed number.',
    'For every uncertain boundary, restart, or suspicious OCR result (l vs 1, O vs 0, missing folios), call document.capture_page_image through evb_run_action with top/bottom or normalized crops where folios sit and inspect the image before deciding.',
    'Call page_labels.preview through evb_read_action with ranges, inclusive segments, or explicit labels, and inspect the normalized segments, samples, issues, and changed-page diff. Commit with page_labels.apply_plan through evb_run_action. If evb_run_action reports confirmation required, denied, or unavailable, no labels were changed: report the preview plan and ask for a grant or manual apply. Re-read page labels and save with file.save only after a verified write.',
].join('\n');

export const ASSISTANT_OCR_READINESS_WORKFLOW = [
    'Check whether the active EVB Viewer document is ready for agent analysis.',
    'Use evb_workspace_snapshot and evb_read_action with document.open_documents or document.readiness first.',
    'For PDFs, call document.inspect_text through evb_read_action to compute searchable text coverage.',
    'If coverage is partial or none, explain that running OCR on all pages is recommended. If the document is DjVu or an image, recommend converting to PDF first.',
].join('\n');

const ASSISTANT_PRESET_INSTRUCTIONS: Record<TAgentAssistantPresetId, string> = {
    'add-bookmarks': ASSISTANT_BOOKMARK_WORKFLOW,
    'number-pages': ASSISTANT_PAGE_NUMBER_WORKFLOW,
    'check-ocr-readiness': ASSISTANT_OCR_READINESS_WORKFLOW,
};

export function resolveAssistantPresetInstructions(presetId: string | null | undefined) {
    if (!presetId) {
        return null;
    }
    return ASSISTANT_PRESET_INSTRUCTIONS[presetId as TAgentAssistantPresetId] ?? null;
}
