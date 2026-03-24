import type { ModelSummary } from "./types.js";

export type ReasoningEffortValue = "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffortValue;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

function canonicalModelId(value?: string): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.includes("/") ? (trimmed.split("/").at(-1) ?? trimmed) : trimmed;
}

function parseModelVersion(value?: string): { major: number; minor: number } | null {
  const canonical = canonicalModelId(value);
  const match = canonical.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1] ?? 0),
    minor: Number(match[2] ?? 0),
  };
}

export function modelSupportsFast(model?: string): boolean {
  const version = parseModelVersion(model);
  if (!version) {
    return false;
  }
  return version.major > 5 || (version.major === 5 && version.minor >= 4);
}

export function modelSupportsReasoning(model?: string): boolean {
  return Boolean(canonicalModelId(model));
}

export function normalizeReasoningEffort(
  value?: string | null,
): ReasoningEffortValue | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  if (
    normalized === "xhigh" ||
    normalized === "extra-high" ||
    normalized === "extra high" ||
    normalized === "extrahigh"
  ) {
    return "xhigh";
  }
  return undefined;
}

export function formatReasoningEffortLabel(value?: string | null): string {
  const normalized = normalizeReasoningEffort(value);
  if (!normalized) {
    return "Default";
  }
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === normalized)?.label ?? normalized;
}

export function getSupportedReasoningEfforts(model?: string): ReasoningEffortValue[] {
  return modelSupportsReasoning(model) ? REASONING_EFFORT_OPTIONS.map((option) => option.value) : [];
}

export function formatModelCapabilitySuffix(model: Pick<ModelSummary, "supportsFast" | "supportsReasoning">): string {
  const capabilities = [
    model.supportsReasoning ? "reasoning" : "",
    model.supportsFast ? "fast" : "",
  ].filter(Boolean);
  return capabilities.length > 0 ? ` [${capabilities.join(", ")}]` : "";
}
