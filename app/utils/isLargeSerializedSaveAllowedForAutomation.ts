export function isLargeSerializedSaveAllowedForAutomation() {
    return typeof window !== 'undefined'
        && typeof window.__allowRendererFileOpenForAutomation === 'function'
        && window.__allowLargeSerializedSaveForAutomation === true;
}
