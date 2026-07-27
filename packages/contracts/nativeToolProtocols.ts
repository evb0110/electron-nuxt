export interface IGeneratedRustNativeToolProtocol {
    binaryName: string;
    crateName: string;
    protocolVersion: number;
    resourceFamilyId: 'pdf-image-combine' | 'pdf-page-ops' | 'pdf-search' | 'scan-cleanup';
    stagingName: string;
}

export const GENERATED_RUST_NATIVE_TOOL_PROTOCOLS = [
    {
        binaryName: 'evb-pdf-image-combine',
        crateName: 'pdf-image-combine',
        protocolVersion: 4,
        resourceFamilyId: 'pdf-image-combine',
        stagingName: 'pdf-image-combine',
    },
    {
        binaryName: 'evb-pdf-page-ops',
        crateName: 'pdf-page-ops',
        protocolVersion: 1,
        resourceFamilyId: 'pdf-page-ops',
        stagingName: 'pdf-page-ops',
    },
    {
        binaryName: 'evb-pdf-search',
        crateName: 'pdf-search',
        protocolVersion: 1,
        resourceFamilyId: 'pdf-search',
        stagingName: 'pdf-search',
    },
    {
        binaryName: 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        // Runtime compatibility revision for the strict manifest parser. This
        // intentionally advances independently of the JSON format's public
        // `version`: adding a field to a deny-unknown-fields Rust struct makes
        // an older executable incompatible even when the v3 wire shape remains
        // additive for current consumers.
        protocolVersion: 4,
        resourceFamilyId: 'scan-cleanup',
        stagingName: 'scan-cleanup',
    },
] as const satisfies readonly IGeneratedRustNativeToolProtocol[];

export const SEARCH_NATIVE_PROTOCOL_VERSION = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS[2].protocolVersion;
