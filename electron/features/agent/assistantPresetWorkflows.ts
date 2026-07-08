import {
    AGENT_ASSISTANT_PRESET_IDS,
    type TAgentAssistantPresetId,
} from '@contracts/agent';
import { isOneOf } from '@contracts/runtimeGuards';

// Universal, edge-case-aware workflows shared by the MCP prompts (prompts/get) and the
// in-app assistant preset chips. Each workflow is a decision tree the model follows so a
// single preset button works regardless of the document's current state.

export const ASSISTANT_LARGE_DOCUMENT_WORKFLOW = [
    'Handle the active document as a large or hard document: thousands of pages, scans, dictionaries, weak OCR, missing TOC, or slow global text coverage.',
    'Start with evb_workspace_snapshot and document.open_documents/readiness to get tab id, physical page count, current page, document kind, and readiness hints. If the document is very large, do not begin with full document.inspect_text unless the user specifically needs global OCR coverage.',
    'Use bounded probes first: document.read_pages for only the current page, likely TOC pages, front/body transition pages, tail pages, or pages found by a narrow search. Treat textStatus.coverageScope = requested-pages as local evidence, not global coverage. If page text is empty, ambiguous, or visually important, use document.capture_page_image on the same page or a normalized crop.',
    'For dictionaries, grammars, catalogs, and other reference books, build structure from samples: cover/title pages, alphabet or chapter starts, running heads, printed page labels, first/last entries, and a few evenly spaced pages. Prefer multiple small probes over one broad scan.',
    'For page labels, infer offsets from sampled visible folios before previewing ranges; avoid asking for every materialized label on huge documents. For bookmarks, read existing TOC/bookmarks when cheap, otherwise derive a candidate outline from verified samples and add only destinations whose page or pageYRatio is proven by text or image evidence.',
    'If any global operation times out or returns partial evidence, continue with targeted read_pages/search/image probes and report the limitation. Recommend OCR all pages only when the task truly needs reliable full-document text, and never pretend that sampled evidence proves complete coverage.',
].join('\n');

export const ASSISTANT_BOOKMARK_WORKFLOW = [
    'Build or correct PDF bookmarks for the active document, whatever its current state.',
    'Read evb://document/{tabId}/toc and /bookmarks. For small or already-indexed documents, inspect text coverage with document.inspect_text; for very large documents, scans, or previous timeouts, follow the large-document bounded-probe workflow instead. Use the flat path list to preserve or extend existing TOC/bookmark nodes; treat existing destinations as hints, not proof.',
    'Choose the outline source in this order: (1) a user-supplied outline if one was given; (2) the embedded TOC/bookmarks; (3) a printed contents page inside the document, located with document.search ("contents", "table of contents") and read with document.read_pages; (4) if none exist, derive the structure yourself from chapter/section starts, heading patterns, numbered headings, and running heads sampled across the document.',
    'Locate every section start with document.search and document.read_pages, and resolve the printed-number vs physical-page offset using evb://document/{tabId}/page-labels so each destination points to the correct physical page and, when a heading starts below the top of that page, a pageYRatio anchor from 0 to 1.',
    'For doubtful title/page matches, duplicated or ambiguous headings, wrong-looking offsets, or OCR gaps, call document.capture_page_image through evb_run_action on candidate pages or crops and inspect the visible page before writing. If the document has little or no searchable text, say OCR is recommended instead of guessing.',
    'Infer a sane hierarchy (parts > chapters > sections) and a reasonable depth. When adding children under existing lesson/chapter bookmarks, prefer bookmarks.add_batch with the parentPath from the flat list instead of replacing the whole tree. Never create direct child bookmarks that reuse the exact destination of their parent; if a printed contents page only proves membership but not the child start position, omit those children or keep them in the response text until document.search/read_pages/capture_page_image can prove a distinct page or pageYRatio anchor.',
    'Call bookmarks.preview_tree through evb_read_action for full-tree changes, or use bookmarks.read before and after add/update calls for incremental changes. Inspect the normalized tree, flat path list, pageYRatio values, issues, and diff, then commit with bookmarks.apply_plan or bookmarks.add_batch through evb_run_action. If evb_run_action reports confirmation required, denied, or unavailable, no bookmarks were changed: report the preview tree and ask for a grant or manual apply. Re-read bookmarks and save with file.save only after a verified write.',
].join('\n');

export const ASSISTANT_PAGE_NUMBER_WORKFLOW = [
    'Reconstruct the PDF page labels to match the document\'s real numbering, whatever scheme it uses.',
    'Read evb://document/{tabId}/page-labels. For small or already-indexed documents, inspect text coverage with document.inspect_text; for very large documents, scans, or previous timeouts, use bounded document.read_pages and document.capture_page_image probes instead of a full coverage pass. Use searchable/OCR text as evidence but never trust it blindly.',
    'Sample the cover, the front-matter/body transition, any appendix/plate/insert sections, and the end. Detect and combine schemes as needed: roman front matter (i, ii, iii), arabic body, restarted numbering, alphabetic or prefixed labels (A, A-1), and unnumbered covers, plates, or blanks. Determine the offset for each range by finding which physical page carries each printed number.',
    'For every uncertain boundary, restart, or suspicious OCR result (l vs 1, O vs 0, missing folios), call document.capture_page_image through evb_run_action with top/bottom or normalized crops where folios sit and inspect the image before deciding.',
    'Call page_labels.preview through evb_read_action with ranges, inclusive segments, or explicit labels, and inspect the normalized segments, samples, issues, and changed-page diff. Commit with page_labels.apply_plan through evb_run_action. If evb_run_action reports confirmation required, denied, or unavailable, no labels were changed: report the preview plan and ask for a grant or manual apply. Re-read page labels and save with file.save only after a verified write.',
].join('\n');

export const ASSISTANT_OCR_READINESS_WORKFLOW = [
    'Check whether the active EVB Viewer document is ready for agent analysis.',
    'Use evb_workspace_snapshot and evb_read_action with document.open_documents or document.readiness first.',
    'For ordinary PDFs, call document.inspect_text through evb_read_action to compute searchable text coverage. For very large, slow, or scanned PDFs, start with bounded document.read_pages samples and page images; only run full inspect_text when global coverage is worth the cost.',
    'If coverage is partial or none, explain that running OCR on all pages is recommended. If the document is DjVu or an image, recommend converting to PDF first.',
].join('\n');

const ASSISTANT_PRESET_INSTRUCTIONS: Record<TAgentAssistantPresetId, string> = {
    'add-bookmarks': ASSISTANT_BOOKMARK_WORKFLOW,
    'number-pages': ASSISTANT_PAGE_NUMBER_WORKFLOW,
    'check-ocr-readiness': ASSISTANT_OCR_READINESS_WORKFLOW,
};

export function resolveAssistantPresetInstructions(presetId: string | null | undefined) {
    if (!isOneOf(AGENT_ASSISTANT_PRESET_IDS, presetId)) {
        return null;
    }
    return ASSISTANT_PRESET_INSTRUCTIONS[presetId] ?? null;
}
