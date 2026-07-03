import type { Ref } from 'vue';
import {
    getAgentNumberInput,
    getAgentNumberArrayInput,
    getAgentStringArrayInput,
    getAgentStringInput,
    hasAgentInputKey,
    isAgentAnnotationTool,
    isAgentOcrPageSegmentationMode,
    isAgentOcrQualityProfile,
    isAgentOcrPageRange,
    isAgentOcrPreprocessingMode,
    isAgentRecord,
    isAgentSidebarTab,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import type { IAgentOcrRunOptions } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import {
    getAgentPageNumberInput,
    normalizeAgentPageNumber,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';

interface IDocumentWorkspaceAgentParsersOptions { totalPages: Ref<number>; }

export function createDocumentWorkspaceAgentParsers(options: IDocumentWorkspaceAgentParsersOptions) {
    function getAgentOcrRunOptions(input: Record<string, unknown>): IAgentOcrRunOptions {
        const pageRange = getAgentStringInput(input, 'pageRange');
        const customRange = getAgentStringInput(input, 'customRange');
        const qualityProfile = getAgentStringInput(input, 'qualityProfile');
        const preprocessingMode = getAgentStringInput(input, 'preprocessingMode');
        const pageSegmentationMode = getAgentNumberInput(input, 'pageSegmentationMode');
        const parsedQualityProfile = isAgentOcrQualityProfile(qualityProfile)
            ? qualityProfile
            : undefined;
        const parsedPreprocessingMode = isAgentOcrPreprocessingMode(preprocessingMode)
            ? preprocessingMode
            : undefined;
        const languages = getAgentStringArrayInput(input, 'languages')
            ?? getAgentStringArrayInput(input, 'selectedLanguages');
        return {
            ...(isAgentOcrPageRange(pageRange) ? {pageRange} : {}),
            ...(customRange === null ? {} : {customRange}),
            ...(parsedQualityProfile === undefined ? {} : {qualityProfile: parsedQualityProfile}),
            ...(parsedPreprocessingMode === undefined ? {} : {preprocessingMode: parsedPreprocessingMode}),
            ...(isAgentOcrPageSegmentationMode(pageSegmentationMode) ? {pageSegmentationMode} : {}),
            ...(languages === undefined ? {} : {languages}),
            open: true,
        };
    }

    const parseEmptyAgentActionInput = () => undefined;
    const parseAgentActionInput = (input: Record<string, unknown>) => input;

    function parseAgentSidebarTab(input: Record<string, unknown>) {
        const nextTab = getAgentStringInput(input, 'tab') ?? getAgentStringInput(input, 'sidebarTab');
        if (!isAgentSidebarTab(nextTab)) {
            throw new Error('ui.open_sidebar_tab requires input.tab: annotations, bookmarks, thumbnails, or search.');
        }
        return nextTab;
    }

    function parseAgentAnnotationRef(input: Record<string, unknown>) {
        const stableKey = getAgentStringInput(input, 'stableKey');
        const annotationId = getAgentStringInput(input, 'annotationId');
        const id = getAgentStringInput(input, 'id');
        if (stableKey === null && annotationId === null && id === null) {
            throw new Error('Annotation comment was not found. Use evb://document/{tabId}/annotations to get stable keys.');
        }
        return input;
    }

    function parseAgentAnnotationToolInput(input: Record<string, unknown>) {
        const tool = input.tool;
        if (!isAgentAnnotationTool(tool)) {
            throw new Error('annotation.select_tool requires input.tool to be a supported annotation tool.');
        }
        return tool;
    }

    function parseAgentViewModeInput(input: Record<string, unknown>) {
        const mode = getAgentStringInput(input, 'mode');
        if (mode !== 'single' && mode !== 'facing' && mode !== 'facing-first-single') {
            throw new Error('view.set_mode requires input.mode: single, facing, or facing-first-single.');
        }
        return mode;
    }

    function parseAgentInsertPagesInput(input: Record<string, unknown>) {
        return getAgentNumberInput(input, 'afterPage') ?? options.totalPages.value;
    }

    function parseAgentPageImageInput(input: Record<string, unknown>, actionId: string) {
        const page = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber');
        if (page !== null) {
            normalizeAgentPageNumber(page, options.totalPages.value, actionId);
        }

        const hasExplicitCrop = [
            'x',
            'y',
            'width',
            'height',
        ].some(key => hasAgentInputKey(input, key));
        if (hasExplicitCrop) {
            const x = getAgentNumberInput(input, 'x') ?? 0;
            const y = getAgentNumberInput(input, 'y') ?? 0;
            const width = getAgentNumberInput(input, 'width') ?? 1;
            const height = getAgentNumberInput(input, 'height') ?? 1;
            if (Math.min(1, Math.max(0, x + width)) <= Math.min(1, Math.max(0, x))
                || Math.min(1, Math.max(0, y + height)) <= Math.min(1, Math.max(0, y))) {
                throw new Error('document.capture_page_image crop must have a positive normalized width and height.');
            }
            return input;
        }

        const region = getAgentStringInput(input, 'region') ?? 'full';
        if (![
            'full',
            'top',
            'bottom',
            'left',
            'right',
            'center',
        ].includes(region)) {
            throw new Error('document.capture_page_image region must be full, top, bottom, left, right, or center.');
        }
        return input;
    }

    function parseAgentPageLabelApplyRangeInput(input: Record<string, unknown>, actionId: string) {
        const startPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            options.totalPages.value,
            actionId,
        );
        const endPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
            options.totalPages.value,
            actionId,
        );
        if (endPage < startPage) {
            throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
        }
        return input;
    }

    function parseAgentPageLabelSetLabelsInput(input: Record<string, unknown>, actionId: string) {
        if (Array.isArray(input.labels)) {
            return input;
        }
        if (Array.isArray(input.updates)) {
            input.updates
                .filter(isAgentRecord)
                .forEach(update => getAgentPageNumberInput(update, options.totalPages.value, actionId));
            return input;
        }
        getAgentPageNumberInput(input, options.totalPages.value, actionId);
        return input;
    }

    function parseAgentBookmarkBatchInput(input: Record<string, unknown>, actionId: string) {
        if (!Array.isArray(input.bookmarks ?? input.items)) {
            throw new Error(`${actionId} requires input.bookmarks or input.items.`);
        }
        return input;
    }

    function parseAgentBookmarkPathInput(input: Record<string, unknown>, actionId: string) {
        const path = getAgentNumberArrayInput(input, 'path');
        if (!path || path.length === 0) {
            throw new Error(`${actionId} requires input.path.`);
        }
        return input;
    }

    function parseAgentBookmarkPathBatchInput(input: Record<string, unknown>, actionId: string) {
        if (Array.isArray(input.paths)) {
            if (input.paths.length === 0) {
                throw new Error(`${actionId} requires at least one bookmark path.`);
            }
            input.paths.forEach((path) => {
                if (
                    !Array.isArray(path)
                    || path.length === 0
                    || !path.every(value => typeof value === 'number' && Number.isFinite(value))
                ) {
                    throw new Error(`${actionId} requires input.paths to contain non-empty path arrays.`);
                }
            });
            return input;
        }

        if (Array.isArray(input.items) || Array.isArray(input.bookmarks)) {
            const rawItems = input.items ?? input.bookmarks;
            if (!Array.isArray(rawItems) || rawItems.length === 0) {
                throw new Error(`${actionId} requires at least one bookmark path.`);
            }
            rawItems.forEach((item) => {
                if (!isAgentRecord(item)) {
                    throw new Error(`${actionId} requires each input.items item to include a non-empty path.`);
                }
                parseAgentBookmarkPathInput(item, actionId);
            });
            return input;
        }

        const path = getAgentNumberArrayInput(input, 'path');
        if (!path || path.length === 0) {
            throw new Error(`${actionId} requires input.paths, input.items with path, or input.path.`);
        }
        return input;
    }

    return {
        getAgentOcrRunOptions,
        parseAgentActionInput,
        parseAgentAnnotationRef,
        parseAgentAnnotationToolInput,
        parseAgentBookmarkBatchInput,
        parseAgentBookmarkPathBatchInput,
        parseAgentBookmarkPathInput,
        parseAgentInsertPagesInput,
        parseAgentPageImageInput,
        parseAgentPageLabelApplyRangeInput,
        parseAgentPageLabelSetLabelsInput,
        parseAgentSidebarTab,
        parseAgentViewModeInput,
        parseEmptyAgentActionInput,
    };
}
