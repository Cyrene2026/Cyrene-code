import type {
  ProviderModelCatalogMode,
  ProviderType,
} from "../../core/query/transport";

export type AuthCredentialSource = "process_env" | "user_env" | "none";

export type AuthMode = "http" | "local";

export type AuthPersistenceKind =
  | "windows_user_env"
  | "shell_rc_block"
  | "fish_conf_d";

export type AuthPersistenceShell =
  | "windows"
  | "zsh"
  | "bash"
  | "fish"
  | "posix";

export type AuthPersistenceTarget = {
  kind: AuthPersistenceKind;
  shell: AuthPersistenceShell;
  path: string;
  label: string;
  managedByCyrene: true;
};

export type AuthStatus = {
  mode: AuthMode;
  credentialSource: AuthCredentialSource;
  provider: string;
  model: string;
  persistenceTarget: AuthPersistenceTarget | null;
  onboardingAvailable: boolean;
  httpReady: boolean;
};

export type AuthLoginInput = {
  providerBaseUrl: string;
  apiKey: string;
  model?: string;
  providerType?: ProviderType;
};

export type AuthValidationResult = {
  ok: boolean;
  message: string;
  persistenceTarget: AuthPersistenceTarget | null;
  normalizedProviderBaseUrl?: string;
  normalizedApiKey?: string;
  selectedModel?: string;
  availableModels?: string[];
  providerModelMode?: ProviderModelCatalogMode;
  providerType?: ProviderType;
};
