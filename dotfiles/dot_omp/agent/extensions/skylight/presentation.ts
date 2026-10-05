import type {
  AgentToolResult,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@oh-my-pi/pi-coding-agent";
import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { md, text } from "@oh-my-pi/pi-tui";
import {
  DEFAULT_TERMINAL_PREVIEW_LINES,
  OutputPane,
  plainToolCard,
  sanitizeDisplayLines,
  type ToolCardSnapshot,
} from "@oh-my-pi/pi-tui/render";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools";
import { resultText } from "@oh-my-pi/pi-tui/tools/native-view";
import { formatCount, isRecord } from "@oh-my-pi/pi-utils";
import type { Guide } from "./guides";

export function resultContent(
  result: MCPToolCallResult,
): AgentToolResult<SkylightDetails>["content"] {
  // MCPTool's bridge coalesces text and interprets resources; retain REPL blocks
  return result.content.map((item) => {
    if (item.type === "text" || item.type === "image") return item;
    return { type: "text" as const, text: JSON.stringify(item) };
  });
}

interface SkylightDetails {
  topic?: Guide;
  isError?: boolean;
  meta?: MCPToolCallResult["_meta"];
}

function outputMeta(result: AgentToolResult<SkylightDetails>): string[] {
  const meta = result.details?.meta;
  const surface = meta?.["codex/toolSurface"];
  const duration = meta?.["codex/nodeReplExecutionDurationMs"];
  const screenshots = result.content.reduce(
    (count, item) => count + Number(item.type === "image"),
    0,
  );
  const parts: string[] = [];
  if (
    isRecord(surface) &&
    isRecord(surface.app) &&
    typeof surface.app.appId === "string"
  ) {
    parts.push(surface.app.appId);
  }
  if (typeof duration === "number" && Number.isFinite(duration))
    parts.push(`${Math.round(duration)} ms`);
  if (screenshots) parts.push(formatCount("screenshot", screenshots));
  return parts;
}

const RESULT_STATUS = {
  running: { icon: "running", title: "Running" },
  error: { icon: "error", title: "Failed" },
  success: { icon: "success", title: "Done" },
} as const;

function renderOutput(
  result: AgentToolResult<SkylightDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  const phase = options.isPartial ? "running" : result.isError ? "error" : "success";
  const output = resultText(result);
  let pane: OutputPane | undefined;
  if (output) {
    pane = new OutputPane(theme, {
      expanded: options.expanded,
      collapsedMaxLines: DEFAULT_TERMINAL_PREVIEW_LINES,
      visual: true,
      edge: "head",
      styleLine: (line) => theme.fg("toolOutput", line),
    });
    pane.setLines(sanitizeDisplayLines(output));
  }
  // The host appends content images independently of custom text renderers
  const snapshot = {
    phase,
    applyBg: false,
    status: {
      ...RESULT_STATUS[phase],
      ...(options.spinnerFrame !== undefined
        ? { spinnerFrame: options.spinnerFrame }
        : {}),
      meta: outputMeta(result),
    },
    ...(pane ? { body: pane } : {}),
  } satisfies ToolCardSnapshot;
  return plainToolCard(theme, () => snapshot);
}

function describeOutput(
  result: AgentToolResult<SkylightDetails>,
  markdown = false,
): NativeToolView {
  const output = resultText(result);
  return {
    tool: { meta: outputMeta(result) },
    ...(result.isError ? { tone: "error" as const } : {}),
    body: output ? [markdown ? md(output) : text(output, { wrap: "word" })] : [],
    preview: { lines: DEFAULT_TERMINAL_PREVIEW_LINES },
  };
}

type SkylightPresentation<TParams extends ToolDefinition["parameters"]> = Pick<
  ToolDefinition<TParams, SkylightDetails>,
  | "parameters"
  | "label"
  | "renderCall"
  | "renderResult"
  | "describeCall"
  | "describeResult"
>;

// Keep schema inference and both presentations attached to the same tool
export function skylightPresentation<TParams extends ToolDefinition["parameters"]>(
  parameters: TParams,
  label: string,
  target: (input: Partial<Parameters<ToolDefinition<TParams>["execute"]>[1]>) => string,
  markdown = false,
): SkylightPresentation<TParams> {
  return {
    parameters,
    label,
    renderCall: (args, options, theme) => {
      const snapshot = {
        applyBg: false,
        status: {
          ...(options.isPartial ? { icon: "pending" as const } : {}),
          title: label,
          description: target(args),
        },
      } satisfies ToolCardSnapshot;
      return plainToolCard(theme, () => snapshot);
    },
    renderResult: renderOutput,
    describeCall: (args) => ({
      tool: { title: label, target: target(args) },
    }),
    describeResult: (result) => describeOutput(result, markdown),
  };
}
