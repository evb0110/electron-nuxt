export interface IAssistantMessageTextSegment {
    kind: 'text';
    text: string;
}

export interface IAssistantMessageInlineCodeSegment {
    kind: 'code';
    text: string;
}

export type TAssistantMessageSegment =
    | IAssistantMessageTextSegment
    | IAssistantMessageInlineCodeSegment;

export interface IAssistantMessageTextBlock {
    kind: 'text';
    segments: TAssistantMessageSegment[];
}

export interface IAssistantMessageCodeBlock {
    kind: 'code';
    language: string | null;
    code: string;
}

export type TAssistantMessageBlock =
    | IAssistantMessageTextBlock
    | IAssistantMessageCodeBlock;

const FENCE_PATTERN = /^\s*```([^\s`]*)?\s*$/u;

function appendTextSegment(segments: TAssistantMessageSegment[], text: string) {
    if (text.length === 0) {
        return;
    }
    segments.push({
        kind: 'text',
        text,
    });
}

function parseInlineCodeSegments(text: string) {
    const segments: TAssistantMessageSegment[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('`', cursor);
        if (start < 0) {
            appendTextSegment(segments, text.slice(cursor));
            break;
        }

        const end = text.indexOf('`', start + 1);
        if (end < 0) {
            appendTextSegment(segments, text.slice(cursor));
            break;
        }

        const code = text.slice(start + 1, end);
        if (code.length === 0) {
            appendTextSegment(segments, text.slice(cursor, end + 1));
            cursor = end + 1;
            continue;
        }

        appendTextSegment(segments, text.slice(cursor, start));
        segments.push({
            kind: 'code',
            text: code,
        });
        cursor = end + 1;
    }

    return segments;
}

function pushTextBlock(blocks: TAssistantMessageBlock[], lines: string[]) {
    if (lines.length === 0) {
        return;
    }

    const text = lines.join('\n');
    blocks.push({
        kind: 'text',
        segments: parseInlineCodeSegments(text),
    });
    lines.length = 0;
}

function normalizeFenceLanguage(language: string | undefined) {
    const normalized = language?.trim();
    if (!normalized) {
        return null;
    }
    return normalized;
}

export function formatAssistantMessage(text: string) {
    const blocks: TAssistantMessageBlock[] = [];
    const textLines: string[] = [];
    let codeLanguage: string | null = null;
    let codeLines: string[] | null = null;

    for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
        const fenceMatch = line.match(FENCE_PATTERN);
        if (codeLines) {
            if (fenceMatch) {
                blocks.push({
                    kind: 'code',
                    language: codeLanguage,
                    code: codeLines.join('\n'),
                });
                codeLanguage = null;
                codeLines = null;
                continue;
            }
            codeLines.push(line);
            continue;
        }

        if (fenceMatch) {
            pushTextBlock(blocks, textLines);
            codeLanguage = normalizeFenceLanguage(fenceMatch[1]);
            codeLines = [];
            continue;
        }

        if (line.trim().length === 0) {
            pushTextBlock(blocks, textLines);
            continue;
        }

        textLines.push(line);
    }

    if (codeLines) {
        blocks.push({
            kind: 'code',
            language: codeLanguage,
            code: codeLines.join('\n'),
        });
    } else {
        pushTextBlock(blocks, textLines);
    }

    return blocks;
}
