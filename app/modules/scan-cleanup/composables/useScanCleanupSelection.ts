import type {
    IScanCleanupMarginsMm,
    IScanCleanupManualZones,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupOptions,
    IScanCleanupPageOverride,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupPageAlignment,
    TScanCleanupPageLayoutOverride,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import {
    DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE,
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupOutputPlacement,
} from '@contracts/scanCleanupPageOverrides';
import {
    resolveScanCleanupSelection,
    type TScanCleanupSelectionIntent,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupSelection';
import {
    resolveScanCleanupApplyScope,
    type TScanCleanupApplyScope,
} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrides,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';
import {
    resolveScanCleanupMarginPatch,
    scanCleanupMarginsUniform,
    type TScanCleanupMarginTarget,
} from '@app/modules/scan-cleanup/runtime/updateScanCleanupMargins';

interface IUseScanCleanupSelectionOptions {
    initialPage: number;
    previewResult: () => IScanCleanupPreviewResult | null;
    previewTotalPages: () => number;
    settings: IScanCleanupOptions;
}

export type TScanCleanupSettingsScope = 'all' | 'page' | 'selected';
export type TScanCleanupOverrideControl = 'layout' | 'rotation' | 'inclusion' | 'margins' | 'placement';

export const useScanCleanupSelection = (options: IUseScanCleanupSelectionOptions) => {
    const leader = ref(options.initialPage);
    const anchor = ref(options.initialPage);
    const selectedPages = shallowRef<ReadonlySet<number>>(new Set([options.initialPage]));
    const settingsScope = ref<TScanCleanupSettingsScope>('all');
    const highlightedScope = ref<TScanCleanupSettingsScope | null>(null);
    const marginsLinked = ref(true);
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;
    const currentPageOverride = computed(() => getScanCleanupPageOverride(options.settings.pageOverrides, leader.value));
    const selectedPageNumbers = computed(() => [...selectedPages.value].sort((left, right) => left - right));
    const selectedPageOverrides = computed(() => selectedPageNumbers.value
        .map(page => getScanCleanupPageOverride(options.settings.pageOverrides, page)));
    const layoutOverride = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.layoutOverride),
    ));
    const rotation = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.rotationDegrees),
    ));
    const excluded = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.excluded),
    ));
    const manualSplit = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.manualSplit),
    ));
    const manualSkew = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.manualSkewDegrees),
    ));
    const contentBoxes = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => override.manualContentBoxes ?? {}),
    ));
    const margins = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.map(override => resolveScanCleanupMarginsMm(options.settings.marginsMm, override)),
    ));
    const hasMarginOverrides = computed(() => selectedPageOverrides.value
        .some(override => override.marginsMm !== undefined));
    const placementAlignment = computed(() => resolveScanCleanupMixedValue(
        selectedPageOverrides.value.flatMap(override => ([
            'full',
            'left',
            'right',
        ] as const)
            .map(half => resolveScanCleanupOutputPlacement(options.settings.pageAlignment, override, half))),
    ));
    const currentOutputHalves = computed<TScanCleanupOutputHalf[]>(() => {
        const result = options.previewResult();
        const halves = result?.pageNumber === leader.value
            ? result.outputs.map(output => output.metadata.half)
            : [];
        return halves.length > 0 ? halves : ['full'];
    });
    const currentPlacementAlignment = computed(() => {
        const alignments = currentOutputHalves.value.map(half => resolveScanCleanupOutputPlacement(
            options.settings.pageAlignment,
            currentPageOverride.value,
            half,
        ));
        return alignments.every(alignment => alignment === alignments[0])
            ? alignments[0] ?? options.settings.pageAlignment
            : null;
    });

    function updateOverrides(
        pages: Iterable<number>,
        update: Parameters<typeof updateScanCleanupPageOverrides>[2],
    ) {
        updateScanCleanupPageOverrides(options.settings.pageOverrides, pages, update, options.settings.marginsMm);
    }

    function updatePageOverride(page: number, value: IScanCleanupPageOverride) {
        updateOverrides([page], previous => previous.rotationDegrees === value.rotationDegrees
            ? value
            : {
                ...value,
                manualSplit: null,
                manualSkewDegrees: undefined,
                manualContentBoxes: {},
                manualZones: {
                    picture: [],
                    fill: [],
                },
            });
    }

    function updateLayoutOverride(
        value: TScanCleanupPageLayoutOverride,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            layoutOverride: value,
        }));
    }

    function updateRotation(
        value: TScanCleanupPageRotation,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            rotationDegrees: value,
            manualSplit: current.rotationDegrees === value ? current.manualSplit : null,
            manualSkewDegrees: current.rotationDegrees === value ? current.manualSkewDegrees : undefined,
            manualContentBoxes: current.rotationDegrees === value ? current.manualContentBoxes ?? {} : {},
            manualZones: current.rotationDegrees === value ? current.manualZones ?? {
                picture: [],
                fill: [],
            } : {
                picture: [],
                fill: [],
            },
        }));
    }

    function updateExcluded(value: boolean, pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => ({
            ...current,
            excluded: value,
        }));
    }

    function resetManualSplit(pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => ({
            ...current,
            manualSplit: null,
        }));
    }

    function updateManualSkew(
        value: number | undefined,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            manualSkewDegrees: value,
        }));
    }

    function resetManualSkew(pages: Iterable<number> = selectedPages.value) {
        updateManualSkew(undefined, pages);
    }

    function resetContentBoxes(pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => ({
            ...current,
            manualContentBoxes: {},
        }));
    }

    function updateMargins(
        target: TScanCleanupMarginTarget,
        value: number,
        pages: Iterable<number> = selectedPages.value,
    ) {
        const effectiveTarget = marginsLinked.value ? 'all' : target;
        updateOverrides(pages, current => ({
            ...current,
            marginsMm: {
                ...resolveScanCleanupMarginsMm(options.settings.marginsMm, current),
                ...resolveScanCleanupMarginPatch(effectiveTarget, value),
            },
        }));
    }

    function setMarginsLinked(
        linked: boolean,
        pages: Iterable<number> = selectedPages.value,
        effectiveMargins?: IScanCleanupMarginsMm,
    ) {
        marginsLinked.value = linked;
        const effective = effectiveMargins === undefined
            ? margins.value
            : resolveScanCleanupMixedValue([effectiveMargins]);
        if (linked && !effective.mixed && effective.value && !scanCleanupMarginsUniform(effective.value)) {
            updateMargins('all', effective.value.topMm, pages);
        }
    }

    function resetMargins(pages: Iterable<number> = selectedPages.value) {
        updateOverrides(pages, current => {
            const {
                marginsMm: _marginsMm,
                ...withoutMargins
            } = current;
            return withoutMargins;
        });
    }

    function resetControlOverride(
        control: TScanCleanupOverrideControl,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => {
            if (control === 'layout') {
                return {
                    ...current,
                    layoutOverride: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.layoutOverride,
                };
            }
            if (control === 'rotation') {
                const rotationChanged = current.rotationDegrees
                    !== DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees;
                return {
                    ...current,
                    rotationDegrees: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.rotationDegrees,
                    manualSplit: rotationChanged ? null : current.manualSplit,
                    manualSkewDegrees: rotationChanged ? undefined : current.manualSkewDegrees,
                    manualContentBoxes: rotationChanged ? {} : current.manualContentBoxes ?? {},
                    manualZones: rotationChanged ? {
                        picture: [],
                        fill: [],
                    } : current.manualZones ?? {
                        picture: [],
                        fill: [],
                    },
                };
            }
            if (control === 'inclusion') {
                return {
                    ...current,
                    excluded: DEFAULT_SCAN_CLEANUP_PAGE_OVERRIDE.excluded,
                };
            }
            if (control === 'margins') {
                const {
                    marginsMm: _marginsMm,
                    ...withoutMargins
                } = current;
                return withoutMargins;
            }
            const {
                placementOverrides: _placementOverrides,
                ...withoutPlacement
            } = current;
            return withoutPlacement;
        });
    }

    function updatePlacement(
        value: TScanCleanupPageAlignment,
        pages: Iterable<number> = selectedPages.value,
    ) {
        updateOverrides(pages, current => ({
            ...current,
            placementOverrides: {
                ...current.placementOverrides,
                full: value,
                left: value,
                right: value,
            },
        }));
    }

    function applyLeaderOverrides(scope: TScanCleanupApplyScope) {
        const pages = resolveScanCleanupApplyScope({
            leader: leader.value,
            pageCount: options.previewTotalPages(),
            selectedPages: selectedPages.value,
        }, scope);
        updateOverrides(pages, () => currentPageOverride.value);
    }

    function updateCurrentManualSplit(value: IScanCleanupNormalizedSplit | null) {
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualSplit: value,
        });
    }

    function updateCurrentManualContentBox(
        half: TScanCleanupOutputHalf,
        value: IScanCleanupNormalizedRect | null,
    ) {
        const manualContentBoxes = {...currentPageOverride.value.manualContentBoxes};
        if (value) manualContentBoxes[half] = value;
        else Reflect.deleteProperty(manualContentBoxes, half);
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualContentBoxes,
        });
    }

    function updateCurrentManualZones(value: IScanCleanupManualZones) {
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            manualZones: value,
        });
    }

    function updateCurrentPlacement(half: TScanCleanupOutputHalf, value: TScanCleanupPageAlignment | null) {
        const placementOverrides = {...currentPageOverride.value.placementOverrides};
        if (value) placementOverrides[half] = value;
        else Reflect.deleteProperty(placementOverrides, half);
        updatePageOverride(leader.value, {
            ...currentPageOverride.value,
            placementOverrides,
        });
    }

    function updateCurrentPlacementAll(value: TScanCleanupPageAlignment) {
        options.settings.pageAlignment = value;
        updateOverrides(Object.keys(options.settings.pageOverrides).map(Number), current => {
            const placementOverrides = Object.fromEntries(Object.entries(current.placementOverrides ?? {})
                .filter(([
                    ,
                    alignment,
                ]) => alignment !== value));
            return {
                ...current,
                placementOverrides,
            };
        });
    }

    function resetOverrides(pages: Iterable<number>) {
        updateOverrides(pages, () => ({
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
        }));
    }

    function setSettingsScope(value: TScanCleanupSettingsScope) {
        if (value === 'selected' && selectedPages.value.size < 2) {
            return;
        }
        settingsScope.value = value;
    }

    function highlightSettingsScope(value: TScanCleanupSettingsScope) {
        settingsScope.value = value;
        highlightedScope.value = value;
        if (highlightTimer !== null) {
            clearTimeout(highlightTimer);
        }
        highlightTimer = setTimeout(() => {
            highlightedScope.value = null;
            highlightTimer = null;
        }, 250);
    }

    function selectPage(page: number, intent: TScanCleanupSelectionIntent, orderedPages: readonly number[]) {
        const previousCount = selectedPages.value.size;
        const selection = resolveScanCleanupSelection({
            anchor: anchor.value,
            leader: leader.value,
            selectedPages: selectedPages.value,
        }, page, intent, orderedPages);
        anchor.value = selection.anchor;
        leader.value = selection.leader;
        selectedPages.value = selection.selectedPages;
        if (intent !== 'single' && selection.selectedPages.size >= 2) {
            highlightSettingsScope('selected');
        } else if (previousCount >= 2 && selection.selectedPages.size <= 1) {
            highlightSettingsScope('page');
        }
    }

    function resetToLeader(pageCount: number) {
        const page = Math.min(Math.max(1, leader.value), pageCount);
        anchor.value = page;
        leader.value = page;
        selectedPages.value = new Set([page]);
        settingsScope.value = 'all';
        highlightedScope.value = null;
    }

    watch(selectedPages, () => {
        const effective = margins.value;
        marginsLinked.value = effective.mixed || !effective.value
            ? true
            : scanCleanupMarginsUniform(effective.value);
    });
    onScopeDispose(() => {
        if (highlightTimer !== null) {
            clearTimeout(highlightTimer);
        }
    }, true);

    return {
        applyLeaderOverrides,
        contentBoxes,
        currentPageOverride,
        currentPlacementAlignment,
        excluded,
        layoutOverride,
        leader,
        margins,
        marginsLinked,
        manualSplit,
        manualSkew,
        hasMarginOverrides,
        highlightedScope,
        placementAlignment,
        resetContentBoxes,
        resetControlOverride,
        resetMargins,
        resetManualSplit,
        resetManualSkew,
        resetOverrides,
        resetToLeader,
        rotation,
        selectPage,
        selectedPages,
        setMarginsLinked,
        setSettingsScope,
        settingsScope,
        updateCurrentManualContentBox,
        updateCurrentManualSplit,
        updateCurrentManualZones,
        updateCurrentPlacement,
        updateCurrentPlacementAll,
        updateExcluded,
        updateLayoutOverride,
        updateMargins,
        updateManualSkew,
        updatePageOverride,
        updatePlacement,
        updateRotation,
    };
};
