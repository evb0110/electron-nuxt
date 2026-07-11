export interface IGeneratedRustNativeToolProtocol {
    binaryName: string;
    crateName: string;
    protocolVersion: number;
    resourceFamilyId: 'pdf-image-combine' | 'pdf-page-ops' | 'pdf-search';
    stagingName: string;
}

export const GENERATED_RUST_NATIVE_TOOL_PROTOCOLS = [
    {
        binaryName: 'evb-pdf-image-combine',
        crateName: 'pdf-image-combine',
        protocolVersion: 3,
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
] as const satisfies readonly IGeneratedRustNativeToolProtocol[];

export const SEARCH_NATIVE_PROTOCOL_VERSION = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS[2].protocolVersion;
