import type { Ref } from 'vue';
import type { IPdfPageLabelRange } from '@app/types/pdfContracts';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
} from '@app/utils/pdfPageLabels';
import {
    createAgentPageLabelPlan,
    createAgentPageLabelSnapshot as createAgentPageLabelPlanSnapshot,
    normalizeAgentPageLabelStyle,
} from '@app/utils/agentMetadataPlans';
import {
    getAgentNumberInput,
    getAgentRawStringInput,
    isAgentRecord,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    getAgentPageNumberInput,
    normalizeAgentPageNumber,
    requireAgentPdfPageCount,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';

interface ICreateDocumentAgentPageLabelsOptions {
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelsDirty: Ref<boolean>;
    totalPages: Ref<number>;
}

export function createDocumentAgentPageLabels(options: ICreateDocumentAgentPageLabelsOptions) {
    const {
        handlePageLabelRangesUpdate,
        pageLabelRanges,
        pageLabels,
        pageLabelsDirty,
        totalPages,
    } = options;

    function normalizeAgentPageLabelRange(input: Record<string, unknown>, actionId: string): IPdfPageLabelRange {
        return {
            startPage: getAgentPageNumberInput(input, totalPages.value, actionId),
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function getEffectiveAgentPageLabels() {
        const pageCount = totalPages.value;
        if (pageCount <= 0) {
            return [];
        }
        if (pageLabels.value && pageLabels.value.length === pageCount) {
            return pageLabels.value;
        }
        return buildPageLabelsFromRanges(pageCount, pageLabelRanges.value);
    }

    function createAgentPageLabelSnapshot() {
        return createAgentPageLabelPlanSnapshot({
            totalPages: totalPages.value,
            dirty: pageLabelsDirty.value,
            pageLabelRanges: pageLabelRanges.value,
            pageLabels: pageLabels.value,
        });
    }

    function updateAgentPageLabelRanges(ranges: IPdfPageLabelRange[]) {
        handlePageLabelRangesUpdate(ranges);
        return createAgentPageLabelSnapshot();
    }

    function getAgentPageLabelRangesInput(input: Record<string, unknown>, actionId: string) {
        const rawRanges = input.ranges;
        if (!Array.isArray(rawRanges)) {
            throw new Error(`${actionId} requires input.ranges.`);
        }
        return rawRanges
            .filter(isAgentRecord)
            .map(range => normalizeAgentPageLabelRange(range, actionId));
    }

    function getAgentPageLabelApplyRangeOptions(input: Record<string, unknown>, actionId: string) {
        const startPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            totalPages.value,
            actionId,
        );
        const endPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
            totalPages.value,
            actionId,
        );
        if (endPage < startPage) {
            throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
        }
        return {
            startPage,
            endPage,
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function applyAgentPageLabelsToRange(input: Record<string, unknown>, actionId: string) {
        const {
            startPage,
            endPage,
            style,
            prefix,
            startNumber,
        } = getAgentPageLabelApplyRangeOptions(input, actionId);
        const labels = [...getEffectiveAgentPageLabels()];
        const segmentLabels = buildPageLabelsFromRanges(
            endPage - startPage + 1,
            [{
                startPage: 1,
                style,
                prefix,
                startNumber,
            }],
        );
        segmentLabels.forEach((label, index) => {
            labels[startPage - 1 + index] = label;
        });
        return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
    }

    function setAgentPageLabels(input: Record<string, unknown>, actionId: string) {
        const pageCount = requireAgentPdfPageCount(totalPages.value, actionId);
        const labels = [...getEffectiveAgentPageLabels()];
        const rawLabels = input.labels;
        if (Array.isArray(rawLabels)) {
            rawLabels.slice(0, pageCount).forEach((label, index) => {
                labels[index] = typeof label === 'string' ? label : '';
            });
        }

        const updates = input.updates;
        if (Array.isArray(updates)) {
            updates
                .filter(isAgentRecord)
                .forEach((update) => {
                    const page = getAgentPageNumberInput(update, totalPages.value, actionId);
                    labels[page - 1] = getAgentRawStringInput(update, 'label') ?? '';
                });
        }

        if (!Array.isArray(rawLabels) && !Array.isArray(updates)) {
            const page = getAgentPageNumberInput(input, totalPages.value, actionId);
            labels[page - 1] = getAgentRawStringInput(input, 'label') ?? '';
        }

        return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
    }

    function previewAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        return createAgentPageLabelPlan({
            input,
            totalPages: totalPages.value,
            currentRanges: pageLabelRanges.value,
            currentLabels: pageLabels.value,
            dirty: pageLabelsDirty.value,
            actionId,
        });
    }

    function applyAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentPageLabelPlan(input, actionId);
        const snapshot = updateAgentPageLabelRanges(plan.ranges);
        return {
            ...snapshot,
            plan,
        };
    }

    return {
        applyAgentPageLabelPlan,
        applyAgentPageLabelsToRange,
        createAgentPageLabelSnapshot,
        getAgentPageLabelRangesInput,
        previewAgentPageLabelPlan,
        setAgentPageLabels,
        updateAgentPageLabelRanges,
    };
}
