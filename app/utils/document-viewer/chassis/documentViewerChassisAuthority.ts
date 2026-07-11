import type {
    HTMLAttributes,
    Ref,
    ShallowRef,
    StyleValue,
} from 'vue';
import {
    createDocumentPageSlotRegistry,
    type IDocumentPageSlotRegistry,
} from '@app/utils/document-viewer/page-slots/createDocumentPageSlotRegistry';
import type {
    IDocumentPageSource,
    TDocumentPageSourceKind,
} from '@app/utils/document-viewer/source/documentPageSource';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import {
    createDocumentViewportWritePort,
    type IDocumentViewportWritePort,
} from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import { createDocumentViewerRenderCoordinator } from '@app/utils/document-viewer/chassis/createDocumentViewerRenderCoordinator';

export interface IDocumentViewerChassisAuthority {
    readonly currentPage: Ref<number>;
    readonly pageCount: Ref<number>;
    readonly pageSlots: IDocumentPageSlotRegistry;
    readonly renderCoordinator: ReturnType<typeof createDocumentViewerRenderCoordinator>;
    readonly source: Readonly<ShallowRef<IDocumentPageSource | null>>;
    readonly sourceKind: Ref<TDocumentPageSourceKind>;
    readonly surfaceBudget: typeof workspaceSurfaceBudgetController;
    readonly viewportWritePort: IDocumentViewportWritePort;
    readonly viewportElement: Readonly<ShallowRef<HTMLElement | null>>;
    readonly viewportClass: Readonly<Ref<HTMLAttributes['class']>>;
    readonly viewportStyle: Readonly<Ref<StyleValue>>;
    bindSource(source: IDocumentPageSource | null): void;
    bindViewportElement(element: HTMLElement | null): void;
    bindViewportFeature(binding: IDocumentViewportFeatureBinding): () => void;
    dispatchViewportEvent(type: TDocumentViewportEventType, event?: Event): void;
    navigate(pageNumber: number): number;
}

export type TDocumentViewportEventType = 'scroll' | 'wheel' | 'mousedown' | 'mousemove' | 'mouseup'
    | 'mouseleave' | 'click' | 'dblclick' | 'contextmenu' | 'selectstart';

export interface IDocumentViewportFeatureBinding {
    getClass: () => HTMLAttributes['class'];
    getStyle: () => StyleValue;
    events: Partial<Record<TDocumentViewportEventType, (event?: Event) => void>>;
}

export const documentViewerChassisAuthorityKey = Symbol('document-viewer-chassis-authority') as InjectionKey<
    IDocumentViewerChassisAuthority
>;

export function createDocumentViewerChassisAuthority(
    sourceKind: Ref<TDocumentPageSourceKind>,
    initialPage = 1,
): IDocumentViewerChassisAuthority {
    const currentPage = ref(Math.max(1, Math.trunc(initialPage)));
    const pageCount = ref(0);
    const pageSlots = createDocumentPageSlotRegistry();
    const renderCoordinator = createDocumentViewerRenderCoordinator(pageSlots);
    const source = shallowRef<IDocumentPageSource | null>(null);
    const viewportElement = shallowRef<HTMLElement | null>(null);
    const viewportFeature = shallowRef<IDocumentViewportFeatureBinding | null>(null);
    const viewportClass = computed(() => viewportFeature.value?.getClass() ?? '');
    const viewportStyle = computed(() => viewportFeature.value?.getStyle() ?? {});

    return {
        currentPage,
        pageCount,
        pageSlots,
        renderCoordinator,
        source,
        sourceKind,
        surfaceBudget: workspaceSurfaceBudgetController,
        viewportWritePort: createDocumentViewportWritePort(),
        viewportElement,
        viewportClass,
        viewportStyle,
        bindSource(nextSource) {
            if (nextSource && nextSource.kind !== sourceKind.value) {
                throw new TypeError(`Cannot bind ${nextSource.kind} source to ${sourceKind.value} chassis`);
            }
            if (source.value !== nextSource) {
                this.viewportWritePort.advanceDocumentRevision();
            }
            source.value = nextSource;
            pageCount.value = nextSource?.pageCount ?? 0;
        },
        bindViewportElement(element) {
            viewportElement.value = element;
        },
        bindViewportFeature(binding) {
            viewportFeature.value = binding;
            return () => {
                if (viewportFeature.value === binding) {
                    viewportFeature.value = null;
                }
            };
        },
        dispatchViewportEvent(type, event) {
            viewportFeature.value?.events[type]?.(event);
        },
        navigate(pageNumber) {
            const normalizedPage = Math.max(1, Math.trunc(pageNumber));
            currentPage.value = pageCount.value > 0
                ? Math.min(pageCount.value, normalizedPage)
                : normalizedPage;
            return currentPage.value;
        },
    };
}

export function injectDocumentViewerChassisAuthority() {
    return inject(documentViewerChassisAuthorityKey, null);
}
