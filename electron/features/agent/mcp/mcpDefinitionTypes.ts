import type { IAgentCapabilityDescriptor } from '@contracts/agent';

export interface IMcpToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

export interface IMcpResourceDefinition {
    name: string;
    title: string;
    uri: string;
    description: string;
    mimeType: string;
}

export interface IMcpResourceTemplateDefinition {
    name: string;
    title: string;
    uriTemplate: string;
    description: string;
    mimeType: string;
}

export interface IMcpPromptDefinition {
    name: string;
    title: string;
    description: string;
    arguments?: Array<{
        name: string;
        title: string;
        description: string;
        required?: boolean;
    }>;
}

export type TCapabilityAvailabilityKind =
    | 'always'
    | 'document'
    | 'pdf'
    | 'pdf-path'
    | 'renderer-document'
    | 'renderer-pdf';

export interface IAgentCapabilityTemplate extends Omit<IAgentCapabilityDescriptor, 'availability'> {availabilityKind: TCapabilityAvailabilityKind;}
