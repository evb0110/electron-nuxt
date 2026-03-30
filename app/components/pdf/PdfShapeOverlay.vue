<template>
    <svg
        v-if="isActive || shapes.length > 0 || drawingShape"
        ref="svgRef"
        class="pdf-shape-overlay"
        :class="{ 'is-tool-active': isActive }"
        :viewBox="`0 0 1 1`"
        preserveAspectRatio="none"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointerleave="handlePointerUp"
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
                vector-effect="non-scaling-stroke"
            />
            <polyline
                v-if="shape.type === 'polyline'"
                :points="shapePoints(shape)"
                class="shape-hit-target"
                fill="none"
                stroke="transparent"
                :stroke-width="interactionStrokeWidth(shape)"
                pointer-events="stroke"
                vector-effect="non-scaling-stroke"
            />
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
                vector-effect="non-scaling-stroke"
            />
            <polyline
                v-if="shape.type === 'polyline'"
                :points="shapePoints(shape)"
                fill="none"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="strokeWidthNorm(shape.strokeWidth)"
                vector-effect="non-scaling-stroke"
            />
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
import { clamp } from 'es-toolkit/math';
import type {
    IShapeAnnotation,
    TDrawableShapeType,
    IAnnotationSettings,
} from '@app/types/annotations';

interface IProps {
    pageIndex: number;
    shapes: IShapeAnnotation[];
    drawingShape: IShapeAnnotation | null;
    selectedShapeId: string | null;
    isActive: boolean;
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
    return Math.max(shape.strokeWidth + 8, 12);
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

function getNormalizedCoords(event: PointerEvent) {
    const svg = (event.currentTarget as SVGSVGElement) ?? (event.target as Element)?.closest('svg');
    if (!svg) {
        return null;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    return {
        x,
        y, 
    };
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
    if ((shape.type === 'polyline' || shape.type === 'polygon') && shape.points && shape.points.length > 0) {
        const xs = shape.points.map(point => point.x);
        const ys = shape.points.map(point => point.y);
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
    return {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
    };
});

let pointerDrawing = false;
let pointerDraggingShapeId: string | null = null;

function handlePointerDown(event: PointerEvent) {
    if (!props.isActive || !props.tool) {
        emit('select-shape', null);
        return;
    }
    event.preventDefault();
    const coords = getNormalizedCoords(event);
    if (!coords) {
        return;
    }
    pointerDrawing = true;
    (event.currentTarget as Element)?.setPointerCapture(event.pointerId);
    emit('start-drawing', coords);
}

function handlePointerMove(event: PointerEvent) {
    if (pointerDraggingShapeId) {
        const coords = getNormalizedCoords(event);
        if (!coords) {
            return;
        }
        emit('continue-drag-shape', coords);
        return;
    }
    if (!pointerDrawing) {
        return;
    }
    const coords = getNormalizedCoords(event);
    if (!coords) {
        return;
    }
    emit('continue-drawing', coords);
}

function handlePointerUp() {
    if (pointerDraggingShapeId) {
        pointerDraggingShapeId = null;
        emit('finish-drag-shape');
        return;
    }
    if (!pointerDrawing) {
        return;
    }
    pointerDrawing = false;
    emit('finish-drawing');
}

function handleShapeClick(id: string) {
    if (props.isActive && props.tool) {
        return;
    }
    emit('select-shape', id);
}

function handleShapePointerDown(shape: IShapeAnnotation, event: PointerEvent) {
    if (props.isActive && props.tool) {
        return;
    }

    const coords = getNormalizedCoords(event);
    if (!coords) {
        return;
    }

    pointerDraggingShapeId = shape.id;
    emit('select-shape', shape.id);
    emit('start-drag-shape', {
        shapeId: shape.id,
        ...coords,
    });
    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
}

function handleShapeContextMenu(id: string, event: MouseEvent) {
    emit('select-shape', id);
    emit('shape-contextmenu', {
        shapeId: id,
        clientX: event.clientX,
        clientY: event.clientY,
    });
}
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

.pdf-shape-overlay.is-tool-active {
    pointer-events: auto;
}

.pdf-shape-overlay > g {
    pointer-events: auto;
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
</style>
