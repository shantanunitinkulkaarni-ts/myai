import OpenAI from "openai";
import {
  SAVE_MODE,
  MAX_AGENT_LOOPS,
  MAX_HISTORY_TURNS,
  API_RETRY_COUNT,
  models,
  clientConfig
} from "./config.js";

const client = new OpenAI(clientConfig);

const TRIVIAL_MESSAGE =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yo|sup|good morning|good evening)[\s!.?]*$/i;

const COMPLEX_KEYWORDS =
  /\b(architecture|architect|design|tradeoff|refactor plan|root cause|debug|error|stack trace|deploy|gcp|cloud run|production|not working|broken|fix bug|troubleshoot)\b/i;

export function isTrivialMessage(message) {
  return TRIVIAL_MESSAGE.test((message || "").trim());
}

export function isComplexTask(message, mode) {
  const text = message || "";
  if (mode === "debug") {
    return COMPLEX_KEYWORDS.test(text) || text.length > 120;
  }
  return COMPLEX_KEYWORDS.test(text);
}

export function localTrivialReply() {
  return "Hi. Saving mode is ON — no API call made. Use Code mode for edits. Use Plan/Debug only for architecture or real errors (Sonnet costs more).";
}

export function chooseModel(mode, overrideModel, message, forceSonnet) {
  if (overrideModel?.trim()) return overrideModel.trim();

  if (SAVE_MODE) {
    if (forceSonnet && (mode === "plan" || mode === "debug")) return models.sonnet;
    if (isTrivialMessage(message)) return null;
    if ((mode === "plan" || mode === "debug") && isComplexTask(message, mode)) {
      return models.sonnet;
    }
    return models.haiku;
  }

  if (mode === "plan" || mode === "debug") return models.sonnet;
  return models.haiku;
}

function maxTokensFor(model, message, mode) {
  if (SAVE_MODE && isTrivialMessage(message)) return 0;
  const isSonnet = model === models.sonnet;
  if (isSonnet) return Number(process.env.MAX_TOKENS_SONNET || 700);
  if (mode === "code") return Number(process.env.MAX_TOKENS_CODE || 500);
  return Number(process.env.MAX_TOKENS_HAIKU || 300);
}

export function trimHistory(history) {
  const recent = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS * 2) : [];
  return recent.map((m) => {
    let text = String(m.content || "");
    // Avoid slicing blindly which breaks JSON formatting. Truncate only huge outputs.
    if (text.length > 4000) {
      text = text.slice(0, 4000) + "\n...[truncated to save tokens]";
    }
    return { role: m.role, content: text };
  });
}

export function systemPrompt(mode, projectContext = "") {
  const compact = SAVE_MODE ? "EXTREME TOKEN SAVING MODE. Minimize all output. Never output full files." : "";
  const modeGuide = {
    code: "Implement changes directly. Use replace_in_file instead of write_file for edits.",
    plan: "Provide minimal high-impact steps. No long essays.",
    debug: "Find root cause, propose fix minimally."
  }[mode];

  return `Personal coding agent. Mode: ${mode}. ${modeGuide} ${compact}
Workspace context:
${projectContext || "(none)"}

CRITICAL: Reply with ONLY one JSON object. No markdown. No text before/after JSON.
{
  "assistant_message": "string",
  "actions": [
    { "tool": "read_file", "path": "app/page.tsx", "start_line": 1, "end_line": 50 },
    { "tool": "replace_in_file", "path": "app/page.tsx", "replace_blocks": [{"search": "old line", "replace": "new line"}] }
  ],
  "done": false
}

Tools: list_files, read_file (use start_line and end_line), replace_in_file, write_file (only for new files), search_code, run_command, git_status, git_diff, git_log, git_add_commit, git_push, deploy_gcp

Rules for Token Saving (NON-NEGOTIABLE):
- NEVER output full files in replace_in_file. Use targeted search/replace blocks.
- NEVER use write_file for existing files.
- read_file should be restricted with start_line and end_line to read ONLY what you need.
- Keep assistant_message extremely brief. No polite filler words.

USER-FACING LANGUAGE (mandatory):
- The user is NOT a developer.
- In assistant_message, always use simple English.
- If anything fails, include:
  1) What happened (plain English)
  2) How to fix it (numbered simple steps)
- Do not show raw stack traces alone; summarize them.`;
}

function normalizeAgentJson(obj) {
  if (!obj || typeof obj !== "object") {
    return { assistant_message: String(obj || ""), actions: [], done: true };
  }
  const assistant_message =
    obj.assistant_message || obj.assistantMessage || obj.message || obj.reply || "";
  const actions = Array.isArray(obj.actions) ? obj.actions : [];
  const done = obj.done === undefined ? actions.length === 0 : Boolean(obj.done);
  return { assistant_message, actions, done };
}

export function parseAgentJson(text) {
  if (!text?.trim()) {
    return { assistant_message: "No response from model.", actions: [], done: true, plainFallback: true };
  }

  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return normalizeAgentJson(JSON.parse(cleaned));
  } catch {
    // continue
  }

  const block = cleaned.match(/\{[\s\S]*\}/);
  if (block) {
    try {
      return normalizeAgentJson(JSON.parse(block[0]));
    } catch {
      // continue
    }
  }

  // Model replied in normal words — show them to user instead of erroring.
  return {
    assistant_message: cleaned,
    actions: [],
    done: true,
    plainFallback: true
  };
}

async function callModel({ model, mode, messages, message, jsonOnly = false }) {
  let lastError;
  for (let attempt = 0; attempt <= API_RETRY_COUNT; attempt += 1) {
    try {
      const payload = {
        model,
        temperature: mode === "code" ? 0.2 : 0.35,
        max_tokens: maxTokensFor(model, message, mode),
        messages
      };
      if (jsonOnly) {
        payload.response_format = { type: "json_object" };
      }
      return await client.chat.completions.create(payload);
    } catch (error) {
      lastError = error;
      if (attempt < API_RETRY_COUNT) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export async function runAgentLoop({
  mode,
  message,
  model,
  messages,
  runTool,
  needsApproval,
  onApprovalRequired
}) {
  let completed = false;
  let assistantMessage = "";
  const toolEvents = [];
  let lastUsage = null;

  for (let i = 0; i < MAX_AGENT_LOOPS; i += 1) {
    let completion;
    try {
      completion = await callModel({ model, mode, messages, message, jsonOnly: true });
    } catch {
      completion = await callModel({ model, mode, messages, message, jsonOnly: false });
    }

    lastUsage = completion.usage || null;
    let raw = completion.choices[0]?.message?.content || "";

    let parsed = parseAgentJson(raw);
    if (parsed.plainFallback && i === 0) {
      messages.push({
        role: "user",
        content:
          "Return ONLY valid JSON object with keys assistant_message, actions, done. No extra text."
      });
      try {
        const retry = await callModel({ model, mode, messages, message, jsonOnly: true });
        lastUsage = retry.usage || lastUsage;
        raw = retry.choices[0]?.message?.content || raw;
        parsed = parseAgentJson(raw);
      } catch {
        // keep plainFallback parsed text
      }
    }

    assistantMessage = parsed.assistant_message || assistantMessage;
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];

    if (actions.length === 0) {
      completed = true;
      break;
    }

    for (const action of actions) {
      if (needsApproval(action)) {
        const approvalPayload = await onApprovalRequired({
          action,
          messages,
          model,
          mode,
          assistantMessage,
          toolEvents,
          lastUsage
        });
        return { ok: true, completed: false, needsApproval: true, ...approvalPayload };
      }

      const result = await runTool(action);
      toolEvents.push({ action, result });
      if (!result.ok) {
        const { explainToolFailure } = await import("./plainEnglish.js");
        const plain = explainToolFailure(action, result);
        assistantMessage = [
          parsed.assistant_message || "",
          "",
          `What happened: ${plain.whatHappened}`,
          `How to fix: ${plain.howToFix}`
        ]
          .join("\n")
          .trim();
      }
      messages.push({ role: "assistant", content: JSON.stringify(parsed) });
      messages.push({
        role: "user",
        content: `Tool result for ${action.tool}: ${JSON.stringify(result).slice(0, 10000)}`
      });
    }
  }

  return {
    ok: true,
    completed,
    mode,
    model,
    assistantMessage,
    toolEvents,
    usage: lastUsage
  };
}
