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
            :data-annotation-id="shape.annotationId || null"
            :data-shape-id="shape.id"
            :data-shape-source="shape.source || null"
            :data-stable-key="shape.stableKey || null"
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
                :cx="shapeCenterX(shape)"
                :cy="shapeCenterY(shape)"
                :rx="shapeRadiusX(shape)"
                :ry="shapeRadiusY(shape)"
                class="shape-hit-target"
                fill="transparent"
                stroke="transparent"
                :stroke-width="interactionStrokeWidth(shape)"
                pointer-events="all"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="shape.type === 'line' || shape.type === 'arrow'"
                :x1="lineVisibleX1(shape)"
                :y1="lineVisibleY1(shape)"
                :x2="lineVisibleX2(shape)"
                :y2="lineVisibleY2(shape)"
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
                :stroke-width="visualStrokeWidth(shape)"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="shape.type === 'circle'"
                :cx="shapeCenterX(shape)"
                :cy="shapeCenterY(shape)"
                :rx="shapeRadiusX(shape)"
                :ry="shapeRadiusY(shape)"
                :stroke="shape.color"
                :fill="shape.fillColor ?? 'none'"
                :opacity="shape.opacity"
                :stroke-width="visualStrokeWidth(shape)"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="shape.type === 'line' || shape.type === 'arrow'"
                :x1="lineVisibleX1(shape)"
                :y1="lineVisibleY1(shape)"
                :x2="lineVisibleX2(shape)"
                :y2="lineVisibleY2(shape)"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="visualStrokeWidth(shape)"
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
                    :stroke-width="visualStrokeWidth(shape)"
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
                :stroke-width="visualStrokeWidth(shape)"
                vector-effect="non-scaling-stroke"
            />
            <polyline
                v-if="shape.lineStartStyle === 'openArrow'"
                :points="lineArrowHeadPoints(shape, 'start')"
                fill="none"
                :stroke="shape.color"
                :opacity="shape.opacity"
                :stroke-width="visualStrokeWidth(shape)"
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
                :stroke-width="visualStrokeWidth(shape)"
                vector-effect="non-scaling-stroke"
            />
            <polygon
                v-if="isClosedArrow(shape.lineEndStyle)"
                :points="lineArrowHeadPoints(shape, 'end')"
                :fill="shape.color"
                :opacity="shape.opacity"
            />
        </g>

        <rect
            v-if="focusedShapeId && focusedShapeBounds"
            class="focus-outline"
            :x="focusedShapeOutline.x"
            :y="focusedShapeOutline.y"
            :width="focusedShapeOutline.width"
            :height="focusedShapeOutline.height"
            fill="none"
            stroke-width="1.5"
            stroke-dasharray="3 2"
            vector-effect="non-scaling-stroke"
        />

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
                :stroke-width="visualStrokeWidth(drawingShape)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <ellipse
                v-if="drawingShape.type === 'circle'"
                :cx="shapeCenterX(drawingShape)"
                :cy="shapeCenterY(drawingShape)"
                :rx="shapeRadiusX(drawingShape)"
                :ry="shapeRadiusY(drawingShape)"
                :stroke="drawingShape.color"
                :fill="drawingShape.fillColor ?? 'none'"
                :opacity="drawingShape.opacity"
                :stroke-width="visualStrokeWidth(drawingShape)"
                stroke-dasharray="0.01 0.005"
                vector-effect="non-scaling-stroke"
            />
            <line
                v-if="drawingShape.type === 'line' || drawingShape.type === 'arrow'"
                :x1="lineVisibleX1(drawingShape)"
                :y1="lineVisibleY1(drawingShape)"
                :x2="lineVisibleX2(drawingShape)"
                :y2="lineVisibleY2(drawingShape)"
                :stroke="drawingShape.color"
                :opacity="drawingShape.opacity"
                :stroke-width="visualStrokeWidth(drawingShape)"
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
                    :stroke-width="visualStrokeWidth(drawingShape)"
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
                :stroke-width="visualStrokeWidth(drawingShape)"
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
                :stroke-width="visualStrokeWidth(drawingShape)"
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
            :x="resizeHandleX(resizeHandle)"
            :y="resizeHandleY(resizeHandle)"
            :width="resizeHandleSize.width"
            :height="resizeHandleSize.height"
            rx="0.004"
            ry="0.004"
            vector-effect="non-scaling-stroke"
            @pointerdown.stop.prevent="handleResizeHandlePointerDownEvent(resizeHandle, $event)"
        />

        <rect
            v-if="selectedShapeId && selectedShapeBounds"
            class="selection-outline"
            :x="selectedShapeOutline.x"
            :y="selectedShapeOutline.y"
            :width="selectedShapeOutline.width"
            :height="selectedShapeOutline.height"
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
    TShapeResizeHandle,
} from '@app/types/annotations';
import { usePdfShapeOverlayInteractions } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/usePdfShapeOverlayInteractions';
import { getShapeRect } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getShapeRect';
import { getShapeStrokePointSets } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/getShapeStrokePointSets';

interface IProps {
    shapes: IShapeAnnotation[];
    drawingShape: IShapeAnnotation | null;
    selectedShapeId: string | null;
    focusedShapeId: string | null;
    isActive: boolean;
    isAnnotationToolActive: boolean;
    selectionEnabled: boolean;
    tool: TDrawableShapeType | null;
}

const props = defineProps<IProps>();
const {
    isActive,
    isAnnotationToolActive,
    focusedShapeId,
    selectedShapeId,
    shapes,
} = toRefs(props);

const emit = defineEmits<{
    'start-drawing': [payload: {
        x: number;
        y: number 
    }];
    'continue-drawing': [payload: {
        x: number;
        y: number 
    }];
    'finish-drawing': [];
    'start-drag-shape': [payload: {
        shapeId: string;
        x: number;
        y: number
    }];
    'continue-drag-shape': [payload: {
        x: number;
        y: number
    }];
    'finish-drag-shape': [];
    'start-resize-shape': [payload: {
        shapeId: string;
        handle: TShapeResizeHandle;
        x: number;
        y: number
    }];
    'continue-resize-shape': [payload: {
        x: number;
        y: number
    }];
    'finish-resize-shape': [];
    'select-shape': [id: string | null];
    'shape-contextmenu': [payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }];
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const svgWidth = ref(1);
const svgHeight = ref(1);
const pdfToCssScale = ref(1);
const SELECTION_OUTLINE_PADDING = 0.003;
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
        const style = window.getComputedStyle(entry.target);
        const scaleFactor = Number.parseFloat(style.getPropertyValue('--scale-factor'));
        const userUnit = Number.parseFloat(style.getPropertyValue('--user-unit'));
        pdfToCssScale.value = (
            Number.isFinite(scaleFactor)
            && scaleFactor > 0
            && Number.isFinite(userUnit)
            && userUnit > 0
        ) ? scaleFactor * userUnit : 1;
    }
});

function visualStrokeWidth(shape: Pick<IShapeAnnotation, 'strokeWidth'>) {
    return shape.strokeWidth * pdfToCssScale.value;
}

function interactionStrokeWidth(shape: IShapeAnnotation) {
    if (shape.type === 'line' || shape.type === 'arrow' || shape.type === 'polyline') {
        return Math.max(visualStrokeWidth(shape) + 14, 20);
    }
    return Math.max(visualStrokeWidth(shape) + 10, 14);
}

function hasArrowHead(style: IShapeAnnotation['lineEndStyle']) {
    return style === 'openArrow' || style === 'closedArrow';
}

function isClosedArrow(style: IShapeAnnotation['lineEndStyle']) {
    return style === 'closedArrow';
}

function lineEndpoint(shape: IShapeAnnotation, edge: 'start' | 'end') {
    return edge === 'start'
        ? {
            x: shape.x,
            y: shape.y,
        }
        : {
            x: shape.x2 ?? shape.x,
            y: shape.y2 ?? shape.y,
        };
}

function lineArrowSizing(shape: IShapeAnnotation) {
    const strokeWidth = visualStrokeWidth(shape);
    return {
        headLength: 10 * strokeWidth,
        headHalfWidth: 3.5 * strokeWidth,
    };
}

function formatSvgPoints(points: Array<{
    x: number;
    y: number
}>) {
    return points.map(point => `${point.x},${point.y}`).join(' ');
}

function lineArrowGeometry(shape: IShapeAnnotation, edge: 'start' | 'end') {
    const anchor = lineEndpoint(shape, edge);
    const other = lineEndpoint(shape, edge === 'start' ? 'end' : 'start');
    const w = svgWidth.value;
    const h = svgHeight.value;

    const dxPx = (anchor.x - other.x) * w;
    const dyPx = (anchor.y - other.y) * h;
    const angle = Math.atan2(dyPx, dxPx);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const {
        headLength,
        headHalfWidth,
    } = lineArrowSizing(shape);

    const baseCenterNX = anchor.x - (headLength * cosA) / w;
    const baseCenterNY = anchor.y - (headLength * sinA) / h;

    const perpNX = (-sinA * headHalfWidth) / w;
    const perpNY = (cosA * headHalfWidth) / h;

    const headPoints = [
        anchor,
        {
            x: baseCenterNX + perpNX,
            y: baseCenterNY + perpNY,
        },
        {
            x: baseCenterNX - perpNX,
            y: baseCenterNY - perpNY,
        },
    ];

    return {
        headPoints: formatSvgPoints(headPoints),
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

function lineVisibleX1(shape: IShapeAnnotation) {
    return lineVisibleSegment(shape).x1;
}

function lineVisibleY1(shape: IShapeAnnotation) {
    return lineVisibleSegment(shape).y1;
}

function lineVisibleX2(shape: IShapeAnnotation) {
    return lineVisibleSegment(shape).x2;
}

function lineVisibleY2(shape: IShapeAnnotation) {
    return lineVisibleSegment(shape).y2;
}

function shapeCenterX(shape: IShapeAnnotation) {
    return shape.x + shape.width / 2;
}

function shapeCenterY(shape: IShapeAnnotation) {
    return shape.y + shape.height / 2;
}

function shapeRadiusX(shape: IShapeAnnotation) {
    return shape.width / 2;
}

function shapeRadiusY(shape: IShapeAnnotation) {
    return shape.height / 2;
}

function shapePoints(shape: IShapeAnnotation) {
    return shape.points ? formatSvgPoints(shape.points) : '';
}

function shapeStrokePointSets(shape: IShapeAnnotation) {
    return getShapeStrokePointSets(shape).map(points => formatSvgPoints(points));
}

const selectedShape = computed(() => (
    selectedShapeId.value
        ? shapes.value.find(shape => shape.id === selectedShapeId.value) ?? null
        : null
));

const selectedShapeBounds = computed(() => {
    if (!selectedShape.value) {
        return null;
    }
    return getShapeRect(selectedShape.value);
});

const focusedShape = computed(() => (
    focusedShapeId.value
        ? shapes.value.find(shape => shape.id === focusedShapeId.value) ?? null
        : null
));

const focusedShapeBounds = computed(() => {
    if (!focusedShape.value) {
        return null;
    }
    return getShapeRect(focusedShape.value);
});

const resizeHandleSize = computed(() => ({
    width: 10 / Math.max(svgWidth.value, 1),
    height: 10 / Math.max(svgHeight.value, 1),
}));
const isAnnotationToolBlocked = computed(() => isAnnotationToolActive.value && !isActive.value);

const resizeHandles = computed(() => {
    if (!selectedShape.value || !selectedShapeBounds.value || isActive.value) {
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
    if (!selectedShapeId.value || !selectedShapeBounds.value) {
        return null;
    }

    if (!selectedShape.value) {
        return null;
    }

    if (selectedShape.value.type === 'rectangle' || selectedShape.value.type === 'circle') {
        return null;
    }

    return selectedShapeBounds.value;
});

const selectedShapeOutline = computed(() => {
    const bounds = selectedShapeBounds.value;
    if (!selectedShapeId.value || !bounds) {
        return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }

    return {
        x: bounds.x - SELECTION_OUTLINE_PADDING,
        y: bounds.y - SELECTION_OUTLINE_PADDING,
        width: bounds.width + SELECTION_OUTLINE_PADDING * 2,
        height: bounds.height + SELECTION_OUTLINE_PADDING * 2,
    };
});

const focusedShapeOutline = computed(() => {
    const bounds = focusedShapeBounds.value;
    if (!focusedShapeId.value || !bounds) {
        return {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }

    return {
        x: bounds.x - SELECTION_OUTLINE_PADDING,
        y: bounds.y - SELECTION_OUTLINE_PADDING,
        width: bounds.width + SELECTION_OUTLINE_PADDING * 2,
        height: bounds.height + SELECTION_OUTLINE_PADDING * 2,
    };
});

function resizeHandleX(resizeHandle: { x: number }) {
    return resizeHandle.x - resizeHandleSize.value.width / 2;
}

function resizeHandleY(resizeHandle: { y: number }) {
    return resizeHandle.y - resizeHandleSize.value.height / 2;
}

function handleResizeHandlePointerDownEvent(
    resizeHandle: { handle: TShapeResizeHandle },
    event: PointerEvent,
) {
    handleResizeHandlePointerDown(resizeHandle.handle, event);
}

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
    z-index: var(--app-z-pdf-shape-layer);
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

.selection-outline,
.focus-outline {
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
