import type {
    IShapePoint,
    TAnnotationTool,
    TDrawableShapeType,
} from '@app/types/annotations';
import { uniq } from 'es-toolkit/array';
import type { TAgentTextMarkupKind } from '@app/modules/pdf-viewer/public';
import type {
    TAgentOcrPageRange,
    TWorkspaceAgentSidebarTab,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

const AGENT_ANNOTATION_TOOLS = [
    'none',
    'select',
    'highlight',
    'underline',
    'strikethrough',
    'squiggly',
    'text',
    'draw',
    'rectangle',
    'circle',
    'line',
    'arrow',
    'stamp',
] as const satisfies readonly TAnnotationTool[];

const AGENT_SIDEBAR_TABS = [
    'annotations',
    'bookmarks',
    'thumbnails',
    'search',
] as const satisfies readonly TWorkspaceAgentSidebarTab[];

const AGENT_TEXT_MARKUP_KINDS = [
    'highlight',
    'underline',
    'strikethrough',
    'squiggly',
] as const satisfies readonly TAgentTextMarkupKind[];

const AGENT_SHAPE_TOOLS = [
    'draw',
    'rectangle',
    'circle',
    'line',
    'arrow',
] as const satisfies readonly TDrawableShapeType[];

export function isAgentRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAgentStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

export function getAgentRawStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' ? value : null;
}

export function getAgentNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

export function getAgentBooleanInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'boolean' ? value : null;
}

export function getAgentStringArrayInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            continue;
        }

        const trimmedItem = item.trim();
        if (trimmedItem) {
            strings.push(trimmedItem);
        }
    }
    return strings.length > 0 ? uniq(strings) : undefined;
}

export function getAgentNumberArrayInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const numbers: number[] = [];
    for (const item of value) {
        if (typeof item === 'number' && Number.isFinite(item)) {
            numbers.push(item);
        }
    }
    return numbers.length === value.length ? numbers : undefined;
}

export function hasAgentInputKey(input: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

export function isAgentAnnotationTool(value: unknown): value is TAnnotationTool {
    return typeof value === 'string' && AGENT_ANNOTATION_TOOLS.includes(value as TAnnotationTool);
}

export function isAgentSidebarTab(value: unknown): value is TWorkspaceAgentSidebarTab {
    return typeof value === 'string' && AGENT_SIDEBAR_TABS.includes(value as TWorkspaceAgentSidebarTab);
}

export function isAgentTextMarkupKind(value: unknown): value is TAgentTextMarkupKind {
    return typeof value === 'string' && AGENT_TEXT_MARKUP_KINDS.includes(value as TAgentTextMarkupKind);
}

export function isAgentShapeTool(value: unknown): value is TDrawableShapeType {
    return typeof value === 'string' && AGENT_SHAPE_TOOLS.includes(value as TDrawableShapeType);
}

export function isAgentOcrPageRange(value: unknown): value is TAgentOcrPageRange {
    return value === 'all' || value === 'current' || value === 'custom';
}

export function getAgentNullableStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (value === null) {
        return null;
    }
    return typeof value === 'string' ? value.trim() : undefined;
}

function getAgentPointInput(value: unknown): IShapePoint | null {
    if (!isAgentRecord(value)) {
        return null;
    }
    const x = getAgentNumberInput(value, 'x') ?? getAgentNumberInput(value, 'pageX');
    const y = getAgentNumberInput(value, 'y') ?? getAgentNumberInput(value, 'pageY');
    if (x === null || y === null) {
        return null;
    }
    return {
        x,
        y,
    };
}

export function getAgentPointArrayInput(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const points = value.flatMap((item) => {
        const point = getAgentPointInput(item);
        return point ? [point] : [];
    });
    return points.length > 0 ? points : undefined;
}

export function getAgentStrokeArrayInput(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strokes = value
        .filter(Array.isArray)
        .map(points => points
            .map(getAgentPointInput)
            .flatMap(point => point ? [point] : []))
        .filter(points => points.length > 0);
    return strokes.length > 0 ? strokes : undefined;
}
