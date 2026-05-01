<template>
    <svg
        v-if="isActive || shapes.length > 0 || drawingShape"
        ref="svgRef"
        class="pdf-shape-overlay"
        :class="{
            'annotation-tool-blocked': isAnnotationToolBlocked,
            'is-tool-active': isActive,
            'is-selection-enabled': selectionEnabled,
            'has-shapes': shapes.length > 0,
            'has-selection': Boolean(selectedShapeId),
        }"
        :viewBox="`0 0 1 1`"
        preserveAspectRatio="none"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointerleave="handlePointerUp"
        @contextmenu="handleContextMenu"
    >
        <g
            v-for="shape in shapes"
            :key="shape.id"
            :class="{ 'is-selected': shape.id === selectedShapeId }"
            @pointerdown.stop.prevent="handleShapePointerDown(shape, $event)"
            @click.stop.prevent="handleShapeClick(shape.id)"
            @contextmenu.stop.prevent="handleShapeContextMenu(shape.id, $event)"
        >
            <rect
                v-if="shape.type === 'rectangle'"
                :x="shape.x"
                :y="shape.y"
                :width="shape.width"
                :height="shape.height"
                class="shape-hit-target"
                fill="transparent"
                stroke="transparent"
                :stroke-width="interactionStrokeWidth(shape)"
                pointer-events="all"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="shape.type === 'circle'"
                :cx="shape.x + shape.width / 2"
                :cy="shape.y + shape.height / 2"
                :rx="shape.width / 2"
                :ry="shape.height / 2"
                class="shape-hit-target"
                fill="transparent"
                stroke="transparent"
                :stroke-width="interactionStrokeWidth(shape)"
                pointer-events="all"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="shape.type === 'line' || shape.type === 'arrow'"
                :x1="lineVisibleSegment(shape).x1"
                :y1="lineVisibleSegment(shape).y1"
                :x2="lineVisibleSegment(shape).x2"
                :y2="lineVisibleSegment(shape).y2"
                class="shape-hit-target"
                stroke="transparent"
                :stroke-width="interactionStrokeWidth(shape)"
                pointer-events="stroke"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
            />
            <template v-if="shape.type === 'polyline'">
                <polyline
                    v-for="(points, strokeIndex) in shapeStrokePointSets(shape)"
                    :key="`hit-${shape.id}-${strokeIndex}`"
                    :points="points"
                    class="shape-hit-target"
                    fill="none"
                    stroke="transparent"
                    :stroke-width="interactionStrokeWidth(shape)"
                    pointer-events="stroke"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    vector-effect="non-scaling-stroke"
                />
            </template>
            <polygon
                v-if="shape.type === 'polygon'"
                :points="shapePoints(shape)"
                class="shape-hit-target"
                fill="transparent"
                stroke="transparent"
                :stroke-width="interactionStrokeWidth(shape)"
                pointer-events="all"
                vector-effect="non-scaling-stroke"
            />
            <rect
                v-if="shape.type === 'rectangle'"
                :x="shape.x"
                :y="shape.y"
                :width="shape.width"
                :height="shape.height"
                :stroke="shape.color"
                :fill="shape.fillColor ?? 'none'"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="shape.type === 'circle'"
                :cx="shape.x + shape.width / 2"
                :cy="shape.y + shape.height / 2"
                :rx="shape.width / 2"
                :ry="shape.height / 2"
                :stroke="shape.color"
                :fill="shape.fillColor ?? 'none'"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="shape.type === 'line' || shape.type === 'arrow'"
                :x1="lineVisibleSegment(shape).x1"
                :y1="lineVisibleSegment(shape).y1"
                :x2="lineVisibleSegment(shape).x2"
                :y2="lineVisibleSegment(shape).y2"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
            />
            <template v-if="shape.type === 'polyline'">
                <polyline
                    v-for="(points, strokeIndex) in shapeStrokePointSets(shape)"
                    :key="`stroke-${shape.id}-${strokeIndex}`"
                    :points="points"
                    fill="none"
                    :stroke="shape.color"
                    :opacity="shape.opacity"
                    :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    vector-effect="non-scaling-stroke"
                />
            </template>
            <polygon
                v-if="shape.type === 'polygon'"
                :points="shapePoints(shape)"
                :fill="shape.fillColor ?? 'none'"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <polyline
                v-if="shape.lineStartStyle === 'openArrow'"
                :points="lineArrowHeadPoints(shape, 'start')"
                fill="none"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <polygon
                v-if="isClosedArrow(shape.lineStartStyle)"
                :points="lineArrowHeadPoints(shape, 'start')"
                :fill="shape.color"
                :opacity="shape.opacity"
            />
            <polyline
                v-if="shape.lineEndStyle === 'openArrow'"
                :points="lineArrowHeadPoints(shape, 'end')"
                fill="none"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <polygon
                v-if="isClosedArrow(shape.lineEndStyle)"
                :points="lineArrowHeadPoints(shape, 'end')"
                :fill="shape.color"
                :opacity="shape.opacity"
            />
        </g>

        <g v-if="drawingShape" class="is-drawing">
            <rect
                v-if="drawingShape.type === 'rectangle'"
                :x="drawingShape.x"
                :y="drawingShape.y"
                :width="drawingShape.width"
                :height="drawingShape.height"
                :stroke="drawingShape.color"
                :fill="drawingShape.fillColor ?? 'none'"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="drawingShape.type === 'circle'"
                :cx="drawingShape.x + drawingShape.width / 2"
                :cy="drawingShape.y + drawingShape.height / 2"
                :rx="drawingShape.width / 2"
                :ry="drawingShape.height / 2"
                :stroke="drawingShape.color"
                :fill="drawingShape.fillColor ?? 'none'"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="drawingShape.type === 'line' || drawingShape.type === 'arrow'"
                :x1="lineVisibleSegment(drawingShape).x1"
                :y1="lineVisibleSegment(drawingShape).y1"
                :x2="lineVisibleSegment(drawingShape).x2"
                :y2="lineVisibleSegment(drawingShape).y2"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <template v-if="drawingShape.type === 'polyline'">
                <polyline
                    v-for="(points, strokeIndex) in shapeStrokePointSets(drawingShape)"
                    :key="`drawing-stroke-${strokeIndex}`"
                    :points="points"
                    fill="none"
                    :stroke="drawingShape.color"
                    :opacity="drawingShape.opacity"
                    :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-dasharray="0.01 0.005"
                    vector-effect="non-scaling-stroke"
                />
            </template>
            <polygon
                v-if="isClosedArrow(drawingShape.lineStartStyle)"
                :points="lineArrowHeadPoints(drawingShape, 'start')"
                :fill="drawingShape.color"
                :opacity="drawingShape.opacity"
            />
            <polyline
                v-if="drawingShape.lineStartStyle === 'openArrow'"
                :points="lineArrowHeadPoints(drawingShape, 'start')"
                fill="none"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
            <polygon
                v-if="isClosedArrow(drawingShape.lineEndStyle)"
                :points="lineArrowHeadPoints(drawingShape, 'end')"
                :fill="drawingShape.color"
                :opacity="drawingShape.opacity"
            />
            <polyline
                v-if="drawingShape.lineEndStyle === 'openArrow'"
                :points="lineArrowHeadPoints(drawingShape, 'end')"
                fill="none"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="strokeWidthNorm(drawingShape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
        </g>

        <rect
            v-if="selectedShapeContextBounds"
            class="selection-hit-target"
            :x="selectedShapeContextBounds.x"
            :y="selectedShapeContextBounds.y"
            :width="selectedShapeContextBounds.width"
            :height="selectedShapeContextBounds.height"
            fill="transparent"
            stroke="transparent"
            pointer-events="all"
            @contextmenu.stop.prevent="handleSelectedShapeBoundsContextMenu"
        />

        <rect
            v-for="resizeHandle in resizeHandles"
            :key="`resize-${resizeHandle.handle}`"
            class="selection-resize-handle"
            :class="`selection-resize-handle--${resizeHandle.handle}`"
            :x="resizeHandle.x - resizeHandleSize.width / 2"
            :y="resizeHandle.y - resizeHandleSize.height / 2"
            :width="resizeHandleSize.width"
            :height="resizeHandleSize.height"
            rx="0.004"
            ry="0.004"
            vector-effect="non-scaling-stroke"
            @pointerdown.stop.prevent="handleResizeHandlePointerDown(resizeHandle.handle, $event)"
        />

        <rect
            v-if="selectedShapeId && selectedShapeBounds"
            class="selection-outline"
            :x="selectedShapeBounds.x - 0.003"
            :y="selectedShapeBounds.y - 0.003"
            :width="selectedShapeBounds.width + 0.006"
            :height="selectedShapeBounds.height + 0.006"
            fill="none"
            stroke-width="1"
            stroke-dasharray="4 2"
            vector-effect="non-scaling-stroke"
        />
    </svg>
</template>

<script setup lang="ts">

import { useResizeObserver } from '@vueuse/core';
import type {
    IShapeAnnotation,
    TDrawableShapeType,
    IAnnotationSettings,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { usePdfShapeOverlayInteractions } from '@app/composables/pdf/pdfShapeOverlayInteractions';
import {
    getAllShapePoints,
    getShapeStrokePointSets,
} from '@app/composables/pdf/pdfShapeStrokes';

interface IProps {
    pageIndex: number;
    shapes: IShapeAnnotation[];
    drawingShape: IShapeAnnotation | null;
    selectedShapeId: string | null;
    isActive: boolean;
    isAnnotationToolActive: boolean;
    selectionEnabled: boolean;
    tool: TDrawableShapeType | null;
    settings: IAnnotationSettings;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'start-drawing', payload: {
        x: number;
        y: number 
    }): void;
    (e: 'continue-drawing', payload: {
        x: number;
        y: number 
    }): void;
    (e: 'finish-drawing'): void;
    (e: 'start-drag-shape', payload: {
        shapeId: string;
        x: number;
        y: number
    }): void;
    (e: 'continue-drag-shape', payload: {
        x: number;
        y: number
    }): void;
    (e: 'finish-drag-shape'): void;
    (e: 'start-resize-shape', payload: {
        shapeId: string;
        handle: TShapeResizeHandle;
        x: number;
        y: number
    }): void;
    (e: 'continue-resize-shape', payload: {
        x: number;
        y: number
    }): void;
    (e: 'finish-resize-shape'): void;
    (e: 'select-shape', id: string | null): void;
    (e: 'shape-contextmenu', payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const svgWidth = ref(1);
const svgHeight = ref(1);
const RESIZE_HANDLES: TShapeResizeHandle[] = [
    'nw',
    'ne',
    'sw',
    'se',
];

useResizeObserver(svgRef, (entries) => {
    const entry = entries[0];
    if (entry) {
        svgWidth.value = entry.contentRect.width || 1;
        svgHeight.value = entry.contentRect.height || 1;
    }
});

function strokeWidthNorm(px: number) {
    return px;
}

function interactionStrokeWidth(shape: IShapeAnnotation) {
    if (shape.type === 'line' || shape.type === 'arrow' || shape.type === 'polyline') {
        return Math.max(shape.strokeWidth + 14, 20);
    }
    return Math.max(shape.strokeWidth + 10, 14);
}

function isLineLikeShape(shape: IShapeAnnotation) {
    return shape.type === 'line' || shape.type === 'arrow';
}

function hasArrowHead(style: IShapeAnnotation['lineEndStyle']) {
    return style === 'openArrow' || style === 'closedArrow';
}

function isClosedArrow(style: IShapeAnnotation['lineEndStyle']) {
    return style === 'closedArrow';
}

function lineArrowGeometry(shape: IShapeAnnotation, edge: 'start' | 'end') {
    const anchorX = edge === 'start' ? shape.x : (shape.x2 ?? shape.x);
    const anchorY = edge === 'start' ? shape.y : (shape.y2 ?? shape.y);
    const otherX = edge === 'start' ? (shape.x2 ?? shape.x) : shape.x;
    const otherY = edge === 'start' ? (shape.y2 ?? shape.y) : shape.y;
    const w = svgWidth.value;
    const h = svgHeight.value;

    const dxPx = (anchorX - otherX) * w;
    const dyPx = (anchorY - otherY) * h;
    const angle = Math.atan2(dyPx, dxPx);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const headLength = 10 * shape.strokeWidth;
    const headHalfWidth = 3.5 * shape.strokeWidth;

    const baseCenterNX = anchorX - (headLength * cosA) / w;
    const baseCenterNY = anchorY - (headLength * sinA) / h;

    const perpNX = (-sinA * headHalfWidth) / w;
    const perpNY = (cosA * headHalfWidth) / h;

    const leftX = baseCenterNX + perpNX;
    const leftY = baseCenterNY + perpNY;
    const rightX = baseCenterNX - perpNX;
    const rightY = baseCenterNY - perpNY;

    return {
        headPoints: `${anchorX},${anchorY} ${leftX},${leftY} ${rightX},${rightY}`,
        lineAnchor: {
            x: baseCenterNX,
            y: baseCenterNY, 
        },
    };
}

function lineArrowHeadPoints(shape: IShapeAnnotation, edge: 'start' | 'end') {
    return lineArrowGeometry(shape, edge).headPoints;
}

function lineVisibleSegment(shape: IShapeAnnotation) {
    const start = hasArrowHead(shape.lineStartStyle)
        ? lineArrowGeometry(shape, 'start').lineAnchor
        : {
            x: shape.x,
            y: shape.y,
        };
    const end = hasArrowHead(shape.lineEndStyle)
        ? lineArrowGeometry(shape, 'end').lineAnchor
        : {
            x: shape.x2 ?? shape.x,
            y: shape.y2 ?? shape.y,
        };

    return {
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
    };
}

function shapePoints(shape: IShapeAnnotation) {
    return shape.points?.map(point => `${point.x},${point.y}`).join(' ') ?? '';
}

function shapeStrokePointSets(shape: IShapeAnnotation) {
    return getShapeStrokePointSets(shape).map(points => points.map(point => `${point.x},${point.y}`).join(' '));
}

const selectedShapeBounds = computed(() => {
    if (!props.selectedShapeId) {
        return null;
    }
    const shape = props.shapes.find(s => s.id === props.selectedShapeId);
    if (!shape) {
        return null;
    }
    if (isLineLikeShape(shape)) {
        const x1 = shape.x;
        const y1 = shape.y;
        const x2 = shape.x2 ?? shape.x;
        const y2 = shape.y2 ?? shape.y;
        const minX = Math.min(x1, x2);
        const minY = Math.min(y1, y2);
        return {
            x: minX,
            y: minY,
            width: Math.max(0.01, Math.abs(x2 - x1)),
            height: Math.max(0.01, Math.abs(y2 - y1)),
        };
    }
    if (shape.type === 'polyline' || shape.type === 'polygon') {
        const points = getAllShapePoints(shape);
        if (points.length > 0) {
            const xs = points.map(point => point.x);
            const ys = points.map(point => point.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            return {
                x: minX,
                y: minY,
                width: Math.max(0.01, maxX - minX),
                height: Math.max(0.01, maxY - minY),
            };
        }
    }
    return {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
    };
});

const selectedShape = computed(() => (
    props.selectedShapeId
        ? props.shapes.find(shape => shape.id === props.selectedShapeId) ?? null
        : null
));

const resizeHandleSize = computed(() => ({
    width: 10 / Math.max(svgWidth.value, 1),
    height: 10 / Math.max(svgHeight.value, 1),
}));
const isAnnotationToolBlocked = computed(() => props.isAnnotationToolActive && !props.isActive);

const resizeHandles = computed(() => {
    if (!selectedShape.value || !selectedShapeBounds.value || props.isActive) {
        return [];
    }

    const bounds = selectedShapeBounds.value;
    const corners: Record<TShapeResizeHandle, {
        x: number;
        y: number;
    }> = {
        nw: {
            x: bounds.x,
            y: bounds.y,
        },
        ne: {
            x: bounds.x + bounds.width,
            y: bounds.y,
        },
        sw: {
            x: bounds.x,
            y: bounds.y + bounds.height,
        },
        se: {
            x: bounds.x + bounds.width,
            y: bounds.y + bounds.height,
        },
    };

    return RESIZE_HANDLES.map(handle => ({
        handle,
        x: corners[handle].x,
        y: corners[handle].y,
    }));
});

const selectedShapeContextBounds = computed(() => {
    if (!props.selectedShapeId || !selectedShapeBounds.value) {
        return null;
    }

    const selectedShape = props.shapes.find(shape => shape.id === props.selectedShapeId) ?? null;
    if (!selectedShape) {
        return null;
    }

    if (selectedShape.type === 'rectangle' || selectedShape.type === 'circle') {
        return null;
    }

    return selectedShapeBounds.value;
});

const {
    handleContextMenu,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleResizeHandlePointerDown,
    handleSelectedShapeBoundsContextMenu,
    handleShapeClick,
    handleShapeContextMenu,
    handleShapePointerDown,
} = usePdfShapeOverlayInteractions({
    svgRef,
    svgWidth,
    svgHeight,
    props,
    selectedShape,
    selectedShapeBounds,
    emit: {
        startDrawing: payload => emit('start-drawing', payload),
        continueDrawing: payload => emit('continue-drawing', payload),
        finishDrawing: () => emit('finish-drawing'),
        startDragShape: payload => emit('start-drag-shape', payload),
        continueDragShape: payload => emit('continue-drag-shape', payload),
        finishDragShape: () => emit('finish-drag-shape'),
        startResizeShape: payload => emit('start-resize-shape', payload),
        continueResizeShape: payload => emit('continue-resize-shape', payload),
        finishResizeShape: () => emit('finish-resize-shape'),
        selectShape: id => emit('select-shape', id),
        shapeContextmenu: payload => emit('shape-contextmenu', payload),
    },
});
</script>

<style scoped>
.pdf-shape-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 6;
    pointer-events: none;
}

.pdf-shape-overlay.is-tool-active,
.pdf-shape-overlay.is-selection-enabled {
    pointer-events: auto;
}

.pdf-shape-overlay > g,
.pdf-shape-overlay > g * {
    pointer-events: none;
}

.pdf-shape-overlay.is-selection-enabled > g,
.pdf-shape-overlay.is-selection-enabled > g * {
    pointer-events: auto;
}

.pdf-shape-overlay.annotation-tool-blocked > g,
.pdf-shape-overlay.annotation-tool-blocked > g *,
.pdf-shape-overlay.is-tool-active > g,
.pdf-shape-overlay.is-tool-active > g * {
    pointer-events: none;
}

.shape-hit-target {
    pointer-events: auto;
}

.is-selected {
    cursor: move;
}

.is-drawing {
    pointer-events: none;
}

.selection-outline {
    pointer-events: none;
    stroke: var(--app-pdf-shape-selection-stroke);
}

.selection-resize-handle {
    fill: var(--ui-bg);
    stroke: var(--app-pdf-shape-selection-stroke);
    stroke-width: 1;
}

.selection-hit-target,
.selection-resize-handle {
    pointer-events: none;
}

.pdf-shape-overlay.is-selection-enabled .selection-hit-target,
.pdf-shape-overlay.is-selection-enabled .selection-resize-handle {
    pointer-events: auto;
}

.pdf-shape-overlay.annotation-tool-blocked .selection-hit-target,
.pdf-shape-overlay.annotation-tool-blocked .selection-resize-handle,
.pdf-shape-overlay.is-tool-active .selection-hit-target,
.pdf-shape-overlay.is-tool-active .selection-resize-handle {
    pointer-events: none;
}

.selection-resize-handle--nw,
.selection-resize-handle--se {
    cursor: nwse-resize;
}

.selection-resize-handle--ne,
.selection-resize-handle--sw {
    cursor: nesw-resize;
}
</style>
