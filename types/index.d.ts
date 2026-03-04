#!/usr/bin/env node
export type AZReleaseVariable = {
    /**
     * Variable value.
     */
    value: string;
    /**
     * Whether the variable is marked as secret.
     */
    isSecret: boolean;
};
export type AZEnvironment = {
    /**
     * Environment name.
     */
    name: string;
    /**
     * Environment id.
     */
    id: number;
    /**
     * Environment variables.
     */
    variables: Record<string, AZReleaseVariable>;
};
export type AZReleaseDefinition = {
    /**
     * Release definition name.
     */
    name: string;
    /**
     * Release definition id.
     */
    id: number;
    /**
     * List of environments in the release definition.
     */
    environments: AZEnvironment[];
};
