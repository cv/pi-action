import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
export interface ModelSetupOptions {
    /** Contents of pi's ~/.pi/agent/auth.json: { [providerId]: Credential }. */
    authJson?: string;
    /** Contents of pi's ~/.pi/agent/models.json: { providers: { [id]: CustomProviderConfig } }. */
    modelsJson?: string;
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}
/** Seed a credential store from auth.json; refreshed OAuth tokens live only for this run. */
export declare function credentialsFromAuthJson(authJson: string | undefined): Promise<InMemoryCredentialStore>;
/** models.json apiKey: "!command", an environment variable name, or the key itself. */
export declare function resolveApiKey(value: string | undefined, env?: NodeJS.ProcessEnv): string | undefined;
/** Build providers for models.json's custom providers (the APIs in CUSTOM_APIS; others are skipped). */
export declare function customProviders(modelsJson: string | undefined, options?: Pick<ModelSetupOptions, "env" | "log">): Provider[];
/** Every built-in provider plus models.json's, with auth.json credentials. */
export declare function createActionModels(options?: ModelSetupOptions): Promise<MutableModels>;
export declare function findModel(models: MutableModels, provider: string, modelId: string): Model<Api>;
