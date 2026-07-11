import type {
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type { IAgentOcrRunOptions } from '@app/types/ocrAgent';
import type {
    IOcrSettings,
    TOcrPageRange,
} from '@app/utils/ocr/ocrTypes';

export const OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE = '__automatic_page_segmentation__';

function isOcrPageRange(value: unknown): value is TOcrPageRange {
    return value === 'all' || value === 'current' || value === 'custom';
}

function isOcrQualityProfile(value: unknown): value is TOcrQualityProfile {
    return value === 'balanced' || value === 'accurate' || value === 'poor-scan';
}

function isOcrPreprocessingMode(value: unknown): value is TOcrPreprocessingMode {
    return value === 'off' || value === 'clean';
}

function isOcrPageSegmentationMode(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 13;
}

function isOcrSupersessionPolicy(value: unknown): value is TOcrTextSupersessionPolicy {
    return value === 'missing-only' || value === 'replace-evb' || value === 'replace-all';
}

export function normalizeSelectedOcrLanguages(selectedLanguages: string[]) {
    return Array.from(new Set(selectedLanguages));
}

function normalizeAgentLanguages(
    value: unknown,
    availableLanguageCodes: ReadonlySet<string>,
) {
    if (!Array.isArray(value)) {
        return null;
    }

    const languages: string[] = [];
    for (const language of value) {
        if (typeof language !== 'string') {
            continue;
        }

        const trimmedLanguage = language.trim();
        if (trimmedLanguage && availableLanguageCodes.has(trimmedLanguage)) {
            languages.push(trimmedLanguage);
        }
    }

    return normalizeSelectedOcrLanguages(languages);
}

export function cloneOcrSettingsSnapshot(value: IOcrSettings | null | undefined) {
    return value
        ? {
            pageRange: value.pageRange,
            customRange: value.customRange,
            selectedLanguages: [...value.selectedLanguages],
            qualityProfile: value.qualityProfile,
            preprocessingMode: value.preprocessingMode,
            pageSegmentationMode: value.pageSegmentationMode,
            supersessionPolicy: value.supersessionPolicy,
            replaceAllAcknowledged: value.replaceAllAcknowledged,
        }
        : null;
}

export function applyAgentOcrOptionsToSettings(
    currentSettings: IOcrSettings,
    options: IAgentOcrRunOptions,
    availableLanguageCodes: ReadonlySet<string>,
) {
    const nextSettings = {
        ...currentSettings,
        selectedLanguages: [...currentSettings.selectedLanguages],
    };

    if (isOcrPageRange(options.pageRange)) {
        nextSettings.pageRange = options.pageRange;
    }
    if (typeof options.customRange === 'string') {
        nextSettings.customRange = options.customRange;
    }
    if (isOcrQualityProfile(options.qualityProfile)) {
        nextSettings.qualityProfile = options.qualityProfile;
    }
    if (isOcrPreprocessingMode(options.preprocessingMode)) {
        nextSettings.preprocessingMode = options.preprocessingMode;
    }
    if (isOcrPageSegmentationMode(options.pageSegmentationMode)) {
        nextSettings.pageSegmentationMode = options.pageSegmentationMode;
    }
    if (isOcrSupersessionPolicy(options.supersessionPolicy)) {
        nextSettings.supersessionPolicy = options.supersessionPolicy;
        nextSettings.replaceAllAcknowledged = options.supersessionPolicy === 'replace-all'
            && options.replaceAllAcknowledged === true;
    }

    const languages = normalizeAgentLanguages(options.languages, availableLanguageCodes);
    if (languages !== null) {
        nextSettings.selectedLanguages = languages;
    }

    return nextSettings;
}

export function resolveOcrPageSegmentationSelectValue(pageSegmentationMode: number | null) {
    return pageSegmentationMode === null
        ? OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        : String(pageSegmentationMode);
}

export function resolveOcrPageSegmentationModeFromSelectValue(value: string) {
    const pageSegmentationMode = value === OCR_PAGE_SEGMENTATION_AUTOMATIC_VALUE
        ? null
        : Number(value);

    return isOcrPageSegmentationMode(pageSegmentationMode)
        ? pageSegmentationMode
        : null;
}

export function resolveQualityProfileSettings(
    currentSettings: IOcrSettings,
    nextProfile: TOcrQualityProfile,
    previousProfile: TOcrQualityProfile,
) {
    if (nextProfile === 'poor-scan' && currentSettings.preprocessingMode === 'off') {
        return {
            ...currentSettings,
            preprocessingMode: 'clean' as const,
        };
    }

    if (
        previousProfile === 'poor-scan'
        && nextProfile !== 'poor-scan'
        && currentSettings.preprocessingMode === 'clean'
    ) {
        return {
            ...currentSettings,
            preprocessingMode: 'off' as const,
        };
    }

    return currentSettings;
}
