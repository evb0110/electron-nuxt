import type { IAgentAssistantEvent } from '@contracts/agent';

export function createFakeAssistantPanelEventHarness() {
    const subscribers = new Set<(event: IAgentAssistantEvent) => void>();
    return {
        emit(event: IAgentAssistantEvent) {
            subscribers.forEach(subscriber => subscriber(event));
        },
        subscribe(subscriber: (event: IAgentAssistantEvent) => void) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        },
    };
}
