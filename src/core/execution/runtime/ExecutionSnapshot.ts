export type ConfirmedFileMutation = {
  action: "create_file" | "write_file" | "edit_file" | "apply_patch";
  path: string;
};

export type MultiFileProgressLedger = {
  expectedFileCount?: number;
  targetPaths: string[];
  completedPaths: string[];
  lastCompletedPath?: string;
};

export type SemanticProvider = "lsp" | "ts" | "text";

export type SemanticRoutingHint = {
  provider: SemanticProvider;
  reason:
    | "lsp_available"
    | "lsp_unavailable"
    | "ts_available"
    | "text_fallback";
};

export type SearchMemory = {
  scopedBroadDiscoveryBudget: Map<string, number>;
  searchedScopes: Set<string>;
  discoveredPaths: Set<string>;
  evidenceSignatures: Set<string>;
  semanticRoutingByPath: Map<string, SemanticRoutingHint>;
};

export type FileReadLedgerEntry = {
  path: string;
  revision: number;
  revisionKey: string | null;
  lastReadStartLine: number | null;
  lastReadEndLine: number | null;
  fullyRead: boolean;
  truncated: boolean;
  nextSuggestedStartLine: number | null;
  ranges: Array<{ startLine: number; endLine: number }>;
};

export type ProgressSnapshot = {
  mutationRevision: number;
  phase: UncertaintyPhase;
  analysisSignalCount: number;
  semanticNavigationCount: number;
  completedPathCount: number;
  discoveredPathCount: number;
  evidenceCount: number;
  semanticRoutingCount: number;
  readCoverageUnits: number;
};

export type RunRoundsOptions = {
  allowSilentPostReviewRetry?: boolean;
};

export type UncertaintyMode = "normal" | "simple_multi_file" | "project_analysis";

export type UncertaintyPhase =
  | "discover"
  | "collapse"
  | "execute"
  | "verify"
  | "trace"
  | "synthesize"
  | "blocked";

export type UncertaintyState = {
  mode: UncertaintyMode;
  phase: UncertaintyPhase;
  discoverBudgetUsed: number;
  discoverBudgetMax: number;
  analysisSignalCount: number;
  semanticNavigationCount: number;
  nonProgressAutoContinueUsed: boolean;
  explicitSourceReads: Set<string>;
  explicitTaskPaths: Set<string>;
  verifyRequested: boolean;
  blockedReason: string | null;
};
