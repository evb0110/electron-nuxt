import {
    createApp,
    defineComponent,
    h,
    isRef,
    nextTick,
} from 'vue';
import type {
    Component,
    Ref,
} from 'vue';
import type {
    IAnnotationEnrichmentState,
    TAnnotationEnrichmentSkipReason,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';

/**
 * One mount configuration for every test that renders the annotations panel.
 * The notice component test, the sidebar wiring test and the point-note chip
 * test must agree on stubs, selectors and state shape, so a rendering that only
 * appears under one test's private setup cannot look like working wiring.
 *
 * The harness stubs design-system components only. Whatever it is handed is
 * mounted for real, so the sidebar test still exercises the actual
 * sidebar -> panel -> comments-list prop and event path, and the chip test
 * still observes the list's own classification.
 */

export const ENRICHMENT_NOTICE_SELECTOR = '.notes-enrichment-notice';
export const ENRICHMENT_RETRY_SELECTOR = '.notes-enrichment-retry';

export const PENDING_ENRICHMENT_STATE: IAnnotationEnrichmentState = {
    status: 'pending',
    reason: null,
    canRetry: false,
};

export const ENRICHED_ENRICHMENT_STATE: IAnnotationEnrichmentState = {
    status: 'enriched',
    reason: null,
    canRetry: false,
};

export function skippedEnrichment(
    reason: TAnnotationEnrichmentSkipReason,
    canRetry: boolean,
): IAnnotationEnrichmentState {
    return {
        status: 'skipped',
        reason,
        canRetry,
    };
}

export function failedEnrichment(canRetry: boolean): IAnnotationEnrichmentState {
    return {
        status: 'failed',
        reason: null,
        canRetry,
    };
}

/**
 * A state a test hands to the harness, either fixed for the whole mount or
 * live so the test can drive it after mount the way the viewer bridge does.
 */
export type TEnrichmentStateSource = IAnnotationEnrichmentState | Ref<IAnnotationEnrichmentState>;

export function resolveEnrichmentState(source: TEnrichmentStateSource): IAnnotationEnrichmentState {
    return isRef(source) ? source.value : source;
}

/**
 * Every design-system component the notice, the annotations panel and the
 * sidebar shell render. One stub shape for all of them: an element that keeps
 * its attributes and slot content, so classes, roles and click handlers stay
 * observable.
 */
const STUBBED_DESIGN_SYSTEM_COMPONENTS = [
    'UIcon',
    'UButton',
    'UCheckbox',
    'UPopover',
    'UInput',
];

const DesignSystemStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {
        attrs,
        slots,
    }) => () => h('button', {
        ...attrs,
        type: 'button',
    }, slots.default?.()),
});

export interface IMountedEnrichmentHost {
    host: HTMLElement;
    /**
     * Unmounts the app and detaches its host element. The harness creates the
     * host, so it disposes of it too: a caller that only unmounted the app
     * would leave a detached-but-attached div behind for the next test to
     * query.
     */
    unmount: () => void;
}

/**
 * `props` is read inside the render function, so a test that passes a ref
 * through it gets the same reactive updates production gets from the viewer.
 */
export async function mountEnrichmentHost(
    component: Component,
    props: () => Record<string, unknown>,
): Promise<IMountedEnrichmentHost> {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(component, props())}));
    for (const name of STUBBED_DESIGN_SYSTEM_COMPONENTS) {
        app.component(name, DesignSystemStub);
    }
    app.mount(host);
    await nextTick();
    return {
        host,
        unmount: () => {
            app.unmount();
            host.remove();
        },
    };
}
