import type { Ref } from 'vue';
import { ZOOM } from '@app/constants/pdf-layout';
import type { TPdfSource } from '@app/types/pdf';
import type {
    ISettingsData,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { IAnnotationSettings } from '@app/types/annotations';

interface IUseWorkspaceViewerDefaultsOptions {
    appSettings: Ref<ISettingsData>;
    annotationSettings: Ref<IAnnotationSettings>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<TFitMode>;
    zoom: Ref<number>;
    effectiveZoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    pdfSrc: Ref<TPdfSource | null>;
}

export const useWorkspaceViewerDefaults = (options: IUseWorkspaceViewerDefaultsOptions) => {
    function clampWorkspaceZoomLevel(level: number) {
        if (!Number.isFinite(level)) {
            return 1;
        }
        return Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, level));
    }

    function resolveDisplayZoom() {
        if (Number.isFinite(options.effectiveZoom.value) && options.effectiveZoom.value > 0) {
            return options.effectiveZoom.value;
        }
        return clampWorkspaceZoomLevel(options.zoom.value);
    }

    function resolveZoomBaselineScale() {
        if (!Number.isFinite(options.zoom.value) || Math.abs(options.zoom.value) < 0.0001) {
            return 1;
        }
        const baseline = resolveDisplayZoom() / options.zoom.value;
        if (!Number.isFinite(baseline) || baseline <= 0) {
            return 1;
        }
        return baseline;
    }

    function setCustomZoomFromDisplay(displayZoom: number) {
        const targetDisplayZoom = clampWorkspaceZoomLevel(displayZoom);
        const baselineScale = resolveZoomBaselineScale();
        options.zoom.value = clampWorkspaceZoomLevel(
            targetDisplayZoom / baselineScale,
        );
        options.effectiveZoom.value = targetDisplayZoom;
        options.zoomMode.value = 'custom';
    }

    function applyWorkspaceViewerDefaults() {
        const defaultColor = options.appSettings.value.defaultAnnotationColor;
        options.annotationSettings.value = {
            ...options.annotationSettings.value,
            highlightColor: defaultColor,
            underlineColor: defaultColor,
            strikethroughColor: defaultColor,
            squigglyColor: defaultColor,
            inkColor: defaultColor,
            shapeColor: defaultColor,
        };

        options.viewMode.value = options.appSettings.value.defaultViewMode;
        options.continuousScroll.value = options.appSettings.value.defaultContinuousScroll;

        if (options.appSettings.value.defaultZoomPreset === 'fit-width') {
            options.fitMode.value = 'width';
            options.zoom.value = 1;
            options.effectiveZoom.value = 1;
            options.zoomMode.value = 'fit-width';
            return;
        }

        if (options.appSettings.value.defaultZoomPreset === 'fit-height') {
            options.fitMode.value = 'height';
            options.zoom.value = 1;
            options.effectiveZoom.value = 1;
            options.zoomMode.value = 'fit-height';
            return;
        }

        setCustomZoomFromDisplay(Number(options.appSettings.value.defaultZoomPreset) / 100);
    }

    watch(options.pdfSrc, (nextSrc, previousSrc) => {
        if (nextSrc && !previousSrc) {
            applyWorkspaceViewerDefaults();
        }
    });

    return {
        resolveDisplayZoom,
        setCustomZoomFromDisplay,
    };
};
