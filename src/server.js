import express from "express";
import path from "path";
import {
  port,
  workspaceDir,
  SAVE_MODE,
  MAX_AGENT_LOOPS,
  MAX_HISTORY_TURNS,
  models
} from "./config.js";
import {
  chooseModel,
  isTrivialMessage,
  localTrivialReply,
  runAgentLoop,
  systemPrompt,
  trimHistory
} from "./agent.js";
import {
  getProjectContext,
  getWorkspaceInfo,
  needsApproval,
  previewWrite,
  runTool
} from "./tools.js";
import { getAutoDeployCommand, getPublishReadiness } from "./deploy.js";
import { runAppAudit } from "./audit.js";
import { attachPlainEnglish, explainToolFailure } from "./plainEnglish.js";

function sendError(res, error, status = 500) {
  const message = String(error?.message || error);
  res.status(status).json(attachPlainEnglish({ ok: false, error: message }, message));
}

const app = express();
const state = { pendingApprovals: new Map() };

// Clean up stale approvals after 1 hour to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of state.pendingApprovals.entries()) {
    if (now - data.createdAt > 3600000) {
      state.pendingApprovals.delete(id);
    }
  }
}, 60000);

app.use(express.json({ limit: "3mb" }));
app.use(express.static(path.resolve("public")));

let projectContextCache = "";
let projectContextAt = 0;

async function getCachedProjectContext() {
  const now = Date.now();
  if (!projectContextCache || now - projectContextAt > 60000) {
    projectContextCache = await getProjectContext();
    projectContextAt = now;
  }
  return projectContextCache;
}

function buildMessages(mode, history, message) {
  return [
    { role: "system", content: systemPrompt(mode, projectContextCache) },
    ...trimHistory(history),
    { role: "user", content: message }
  ];
}

app.post("/api/chat", async (req, res) => {
  try {
    const { mode = "code", message, overrideModel, history = [], forceSonnet = false } = req.body;

    if (SAVE_MODE && isTrivialMessage(message)) {
      return res.json({
        ok: true,
        mode,
        model: "local/no-api",
        assistantMessage: localTrivialReply(),
        completed: true,
        toolEvents: [],
        saveMode: true,
        costSaved: true,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

    const model = chooseModel(mode, overrideModel, message, forceSonnet);
    if (!model) {
      return res.json({
        ok: true,
        mode,
        model: "local/no-api",
        assistantMessage: localTrivialReply(),
        completed: true,
        toolEvents: [],
        saveMode: SAVE_MODE,
        costSaved: true,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

    await getCachedProjectContext();
    const messages = buildMessages(mode, history, message);

    const loop = await runAgentLoop({
      mode,
      message,
      model,
      messages,
      runTool,
      needsApproval,
      onApprovalRequired: async (payload) => createApproval(payload, message)
    });

    if (!loop.ok) {
      return res.json(attachPlainEnglish({ ...loop, saveMode: SAVE_MODE }, loop.error || loop.raw));
    }
    res.json({ ...loop, saveMode: SAVE_MODE });
  } catch (error) {
    sendError(res, error);
  }
});

async function createApproval(payload, originalMessage) {
  const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let preview = null;
  if (payload.action.tool === "write_file" || payload.action.tool === "replace_in_file") {
    preview = await previewWrite(payload.action);
  }

  state.pendingApprovals.set(approvalId, {
    ...payload,
    originalMessage,
    createdAt: Date.now()
  });

  return {
    mode: payload.mode,
    model: payload.model,
    assistantMessage: payload.assistantMessage,
    approvalId,
    action: payload.action,
    preview,
    usage: payload.lastUsage
  };
}

app.post("/api/approve", async (req, res) => {
  try {
    const { approvalId, continueAgent = true } = req.body;
    const pending = state.pendingApprovals.get(approvalId);
    if (!pending) return sendError(res, "Approval not found or expired. Please run the action again.", 404);

    const result = await runTool(pending.action);
    pending.toolEvents.push({ action: pending.action, result });

    if (pending.nextAction && pending.action.tool === "git_add_commit" && result.ok) {
      const pushResult = await runTool(pending.nextAction);
      pending.toolEvents.push({ action: pending.nextAction, result: pushResult });
      state.pendingApprovals.delete(approvalId);
      if (!pushResult.ok) {
        const plain = explainToolFailure(pending.nextAction, pushResult);
        return res.json(
          attachPlainEnglish(
            {
              ok: false,
              executed: pending.action,
              result,
              pushResult,
              saveMode: SAVE_MODE
            },
            pushResult.error || "Push to GitHub failed"
          )
        );
      }
      return res.json({
        ok: true,
        assistantMessage: "Done. Your changes were saved and sent to GitHub.",
        plainEnglish: "Done. Your changes were saved and sent to GitHub.",
        executed: pending.action,
        result,
        pushResult,
        saveMode: SAVE_MODE
      });
    }

    pending.messages.push({
      role: "user",
      content: `Approved tool result for ${pending.action.tool}: ${JSON.stringify(result).slice(0, 10000)}`
    });

    if (!continueAgent || pending.mode === "easy") {
      state.pendingApprovals.delete(approvalId);
      if (!result.ok) {
        const plain = explainToolFailure(pending.action, result);
        return res.json(
          attachPlainEnglish(
            { ok: false, executed: pending.action, result, saveMode: SAVE_MODE },
            result.error || "Action failed"
          )
        );
      }
      const doneMsg =
        pending.action.tool === "deploy_gcp"
          ? "Done. Publish command finished. Check Google Cloud console for your live app link."
          : "Done.";
      return res.json({
        ok: true,
        assistantMessage: doneMsg,
        plainEnglish: doneMsg,
        executed: pending.action,
        result,
        saveMode: SAVE_MODE
      });
    }

    const loop = await runAgentLoop({
      mode: pending.mode,
      message: pending.originalMessage,
      model: pending.model,
      messages: pending.messages,
      runTool,
      needsApproval,
      onApprovalRequired: async (payload) => createApproval(payload, pending.originalMessage)
    });

    state.pendingApprovals.delete(approvalId);
    const payload = { ...loop, executed: pending.action, result, saveMode: SAVE_MODE };
    if (!loop.ok) return res.json(attachPlainEnglish(payload, loop.error || loop.raw));
    res.json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/reject", (req, res) => {
  const { approvalId } = req.body;
  state.pendingApprovals.delete(approvalId);
  res.json({ ok: true });
});

app.get("/api/audit", async (_req, res) => {
  try {
    const audit = await runAppAudit();
    res.json({ ok: true, ...audit, costSaved: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/easy/status", async (_req, res) => {
  try {
    const readiness = await getPublishReadiness();
    res.json({ ok: true, ...readiness });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/easy/github-save", async (req, res) => {
  try {
    const message = req.body.message || "Update from personal coder tool";
    const approvalId = `${Date.now()}-github`;
    const action = {
      tool: "git_add_commit",
      message,
      paths: "."
    };
    const preview = { summary: "Save all current changes to Git on your computer." };

    state.pendingApprovals.set(approvalId, {
      action,
      messages: [],
      model: "easy/github",
      mode: "easy",
      assistantMessage: "Ready to save changes to Git.",
      toolEvents: [],
      originalMessage: "easy-github-save",
      nextAction: { tool: "git_push" }
    });

    res.json({
      ok: true,
      needsApproval: true,
      approvalId,
      action,
      preview,
      plainEnglish: "This will save your code locally in Git. After you approve, you can push to GitHub."
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/easy/google-publish", async (req, res) => {
  try {
    const readiness = await getPublishReadiness();
    if (!readiness.ready) {
      return res.json(
        attachPlainEnglish(
          {
            ok: false,
            checks: readiness.items,
            assistantMessage: readiness.message
          },
          readiness.message
        )
      );
    }

    const cmd = await getAutoDeployCommand();
    const action = { tool: "deploy_gcp" };

    const result = await runTool(action);
    if (!result.ok) {
      return res.json(
        attachPlainEnglish(
          { ok: false, executed: action, result, saveMode: SAVE_MODE },
          result.error || "Deploy failed"
        )
      );
    }

    const doneMsg = "Done. Publish command finished. Check Google Cloud console for your live app link.";
    res.json({
      ok: true,
      assistantMessage: doneMsg,
      plainEnglish: doneMsg,
      executed: action,
      result,
      saveMode: SAVE_MODE
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/quick", async (req, res) => {
  try {
    const { action } = req.body;
    if (action === "git_status") {
      return res.json({ ok: true, result: await runTool({ tool: "git_status" }) });
    }
    if (action === "git_diff") {
      return res.json({ ok: true, result: await runTool({ tool: "git_diff" }) });
    }
    if (action === "project_tree") {
      return res.json({ ok: true, result: await runTool({ tool: "list_files", path: ".", depth: 2 }) });
    }
    return sendError(res, "Unknown quick action", 400);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/health", async (_req, res) => {
  const workspace = await getWorkspaceInfo();
  res.json({
    ok: true,
    workspaceDir,
    workspace,
    saveMode: SAVE_MODE,
    defaults: {
      codeModel: models.haiku,
      planDebugModel: models.sonnet
    },
    limits: {
      maxAgentLoops: MAX_AGENT_LOOPS,
      maxHistoryTurns: MAX_HISTORY_TURNS,
      maxTokensCode: process.env.MAX_TOKENS_CODE || 500,
      maxTokensHaiku: process.env.MAX_TOKENS_HAIKU || 300,
      maxTokensSonnet: process.env.MAX_TOKENS_SONNET || 700
    }
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Personal coder tool running on http://0.0.0.0:${port}`);
  console.log(`Workspace: ${workspaceDir}`);
});
