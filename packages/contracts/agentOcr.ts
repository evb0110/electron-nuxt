import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

const AGENT_OCR_PAGE_RANGES = [
    'all',
    'current',
    'custom',
] as const;
const AGENT_OCR_QUALITY_PROFILES = [
    'balanced',
    'accurate',
    'poor-scan',
] as const satisfies readonly TOcrQualityProfile[];
const AGENT_OCR_PREPROCESSING_MODES = [
    'off',
    'clean',
] as const satisfies readonly TOcrPreprocessingMode[];
const AGENT_OCR_SUPERSESSION_POLICIES = [
    'missing-only',
    'replace-evb',
    'replace-all',
] as const satisfies readonly TOcrTextSupersessionPolicy[];

export type TAgentOcrPageRange = typeof AGENT_OCR_PAGE_RANGES[number];

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    qualityProfile?: TOcrQualityProfile;
    preprocessingMode?: TOcrPreprocessingMode;
    pageSegmentationMode?: number;
    supersessionPolicy?: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged?: boolean;
    open?: boolean;
}

export const AGENT_OCR_RUN_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        pageRange: {
            type: 'string',
            enum: AGENT_OCR_PAGE_RANGES,
            description: 'Pages to OCR. Defaults to the OCR popup current setting.',
        },
        customRange: {
            type: 'string',
            description: 'Custom page range such as 1-3,7. Used when pageRange is custom.',
        },
        languages: {
            type: 'array',
            items: {type: 'string'},
            description: 'OCR language codes such as eng, deu, tur. Defaults to the OCR popup current setting.',
        },
        qualityProfile: {
            type: 'string',
            enum: AGENT_OCR_QUALITY_PROFILES,
            description: 'OCR quality profile. Defaults to the OCR popup current setting.',
        },
        preprocessingMode: {
            type: 'string',
            enum: AGENT_OCR_PREPROCESSING_MODES,
            description: 'Optional image preprocessing mode before OCR. Defaults to the OCR popup current setting.',
        },
        pageSegmentationMode: {
            type: 'integer',
            minimum: 0,
            maximum: 13,
            description: 'Optional Tesseract page segmentation mode from 0 to 13.',
        },
        supersessionPolicy: {
            type: 'string',
            enum: AGENT_OCR_SUPERSESSION_POLICIES,
            description: 'Existing text policy. Defaults to the OCR popup current setting.',
        },
        replaceAllAcknowledged: {
            type: 'boolean',
            description: 'Required and must be true when supersessionPolicy is replace-all.',
        },
        open: {
            type: 'boolean',
            description: 'Whether to open the OCR popup. Defaults to true.',
        },
    },
    allOf: [{
        if: {
            properties: {supersessionPolicy: {const: 'replace-all'}},
            required: ['supersessionPolicy'],
        },
        then: {
            properties: {replaceAllAcknowledged: {const: true}},
            required: ['replaceAllAcknowledged'],
        },
    }],
    additionalProperties: false,
};

function normalizeLanguages(value: unknown) {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const languages = value.flatMap((language) => {
        if (typeof language !== 'string') {
            return [];
        }
        const normalized = language.trim();
        return normalized ? [normalized] : [];
    });
    return [...new Set(languages)];
}

export function parseAgentOcrRunOptions(value: unknown): IAgentOcrRunOptions {
    if (!isRecord(value)) {
        return {};
    }

    const customRange = typeof value.customRange === 'string' && value.customRange.trim()
        ? value.customRange.trim()
        : undefined;
    const languages = normalizeLanguages(value.languages);
    return {
        ...(isOneOf(AGENT_OCR_PAGE_RANGES, value.pageRange) ? {pageRange: value.pageRange} : {}),
        ...(customRange === undefined ? {} : {customRange}),
        ...(languages === undefined ? {} : {languages}),
        ...(isOneOf(AGENT_OCR_QUALITY_PROFILES, value.qualityProfile)
            ? {qualityProfile: value.qualityProfile}
            : {}),
        ...(isOneOf(AGENT_OCR_PREPROCESSING_MODES, value.preprocessingMode)
            ? {preprocessingMode: value.preprocessingMode}
            : {}),
        ...(typeof value.pageSegmentationMode === 'number'
            && Number.isInteger(value.pageSegmentationMode)
            && value.pageSegmentationMode >= 0
            && value.pageSegmentationMode <= 13
            ? {pageSegmentationMode: value.pageSegmentationMode}
            : {}),
        ...(isOneOf(AGENT_OCR_SUPERSESSION_POLICIES, value.supersessionPolicy)
            ? {supersessionPolicy: value.supersessionPolicy}
            : {}),
        ...(typeof value.replaceAllAcknowledged === 'boolean'
            ? {replaceAllAcknowledged: value.replaceAllAcknowledged}
            : {}),
        ...(typeof value.open === 'boolean' ? {open: value.open} : {}),
    };
}
