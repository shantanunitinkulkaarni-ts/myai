const chatEl = document.getElementById("chat");
const formEl = document.getElementById("chatForm");
const messageEl = document.getElementById("message");
const modeEl = document.getElementById("mode");
const overrideModelEl = document.getElementById("overrideModel");
const forceSonnetEl = document.getElementById("forceSonnet");
const approvalBoxEl = document.getElementById("approvalBox");
const workspaceInfoEl = document.getElementById("workspaceInfo");
const readyStatusEl = document.getElementById("readyStatus");
const sendBtn = document.getElementById("sendBtn");

let history = [];
let busy = false;

function addBubble(text, role, meta = "") {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    chatEl.appendChild(m);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

let loadingSpinner = null;

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  sendBtn.textContent = value ? "Working..." : "Send";
  
  if (value && !loadingSpinner) {
    loadingSpinner = document.createElement("div");
    loadingSpinner.className = "spinner";
    chatEl.appendChild(loadingSpinner);
    chatEl.scrollTop = chatEl.scrollHeight;
  } else if (!value && loadingSpinner) {
    if (loadingSpinner.parentNode) {
      loadingSpinner.parentNode.removeChild(loadingSpinner);
    }
    loadingSpinner = null;
  }
}

function formatMeta(data) {
  const usage = data.usage ? `tokens ${data.usage.total_tokens ?? "?"}` : "";
  const costNote = data.costSaved ? "free" : "";
  return [`Model: ${data.model}`, `Mode: ${data.mode}`, costNote, usage].filter(Boolean).join(" | ");
}

function formatUserFacingMessage(data) {
  if (typeof data?.plainEnglish === "string") return data.plainEnglish;
  if (data?.plainEnglish?.whatHappened) {
    return [
      "In plain English:",
      `What happened: ${data.plainEnglish.whatHappened}`,
      `How to fix: ${data.plainEnglish.howToFix}`,
      data.plainEnglish.technicalDetails
        ? `(Technical details: ${data.plainEnglish.technicalDetails})`
        : ""
    ]
      .filter(Boolean)
      .join("\n");
  }
  return data?.assistantMessage || data?.error || "Something went wrong.";
}

async function loadHealth() {
  const res = await fetch("/api/health");
  const data = await res.json();
  const git = data.workspace?.git;
  const gitLine = git?.isRepo ? `branch ${git.branch}` : "no git";
  workspaceInfoEl.textContent = `Working on: ${data.workspaceDir} | ${gitLine}`;
}

async function loadReadyStatus() {
  const res = await fetch("/api/easy/status");
  const data = await res.json();
  if (!data.ok) {
    readyStatusEl.textContent = "Could not check readiness.";
    return;
  }

  const lines = data.items.map((i) => `${i.ok ? "✅" : "❌"} ${i.label}: ${i.detail}`).join("\n");
  readyStatusEl.textContent = `${data.message}\n\n${lines}`;
}

function renderApproval(data) {
  approvalBoxEl.classList.remove("hidden");
  const plain = data.plainEnglish ? `<p><strong>In simple terms:</strong> ${data.plainEnglish}</p>` : "";
  const previewBlock = data.preview
    ? `<details open><summary>Details</summary><pre>${JSON.stringify(data.preview, null, 2)}</pre></details>`
    : "";

  const actionLabel = data.action?.tool ? data.action.tool.replace(/_/g, " ") : "action";

  approvalBoxEl.innerHTML = `
    <strong>Please confirm: ${actionLabel}</strong>
    ${plain}
    ${previewBlock}
    <details><summary>Technical details (optional)</summary><pre>${JSON.stringify(data.action, null, 2)}</pre></details>
    <div class="approval-actions">
      <button id="approveBtn">Yes, do it</button>
      <button id="rejectBtn">No, cancel</button>
    </div>
  `;

  document.getElementById("approveBtn").onclick = () => handleApproval(data.approvalId, true);
  document.getElementById("rejectBtn").onclick = async () => {
    await fetch("/api/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: data.approvalId })
    });
    addBubble("Cancelled.", "assistant");
    approvalBoxEl.classList.add("hidden");
  };
}

async function handleApproval(approvalId, continueAgent) {
  setBusy(true);
  const res = await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalId, continueAgent })
  });
  const data = await res.json();
  setBusy(false);
  approvalBoxEl.classList.add("hidden");

  if (!data.ok) {
    addBubble(formatUserFacingMessage(data), "assistant");
    return;
  }

  addBubble(formatUserFacingMessage(data), "assistant", formatMeta(data));
  await loadReadyStatus();
}

async function runEasy(url, body = {}) {
  setBusy(true);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  setBusy(false);

  if (!data.ok && !data.needsApproval) {
    addBubble(formatUserFacingMessage(data), "assistant");
    if (data.checks) {
      const checklist = data.checks
        .map((c) => `${c.ok ? "✅" : "❌"} ${c.label}: ${c.detail}`)
        .join("\n");
      addBubble(checklist, "assistant", "checklist");
    }
    return;
  }

  if (data.needsApproval) {
    renderApproval(data);
    return;
  }

  addBubble(data.plainEnglish || "Done.", "assistant");
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;

  const message = messageEl.value.trim();
  if (!message) return;

  addBubble(message, "user");
  messageEl.value = "";
  setBusy(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: modeEl.value,
        message,
        overrideModel: overrideModelEl.value.trim(),
        forceSonnet: forceSonnetEl.checked,
        history
      })
    });
    const data = await res.json();

    if (!data.ok) {
      addBubble(formatUserFacingMessage(data), "assistant");
      return;
    }

    addBubble(formatUserFacingMessage(data), "assistant", formatMeta(data));
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: data.assistantMessage || "" });

    if (data.needsApproval) {
      renderApproval(data);
      return;
    }

    if (data.toolEvents?.length) {
      addBubble(
        `Done steps:\n${data.toolEvents.map((t) => `- ${t.action.tool}`).join("\n")}`,
        "assistant"
      );
    }
  } finally {
    setBusy(false);
  }
});

document.getElementById("checkApp").onclick = async () => {
  setBusy(true);
  const res = await fetch("/api/audit");
  const data = await res.json();
  setBusy(false);
  if (!data.ok) {
    addBubble(formatUserFacingMessage(data), "assistant");
    return;
  }
  const report = data.lines.map((l) => `${l.ok ? "✅" : "❌"} ${l.label}: ${l.detail}`).join("\n");
  addBubble(`${data.summary}\n\n${report}`, "assistant", "free local check");
};

document.getElementById("checkReady").onclick = loadReadyStatus;
document.getElementById("saveGithub").onclick = () => runEasy("/api/easy/github-save");
document.getElementById("publishGoogle").onclick = () => runEasy("/api/easy/google-publish");
document.getElementById("quickStatus").onclick = async () => {
  setBusy(true);
  const res = await fetch("/api/quick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "git_status" })
  });
  const data = await res.json();
  setBusy(false);
  if (!data.ok) {
    addBubble(formatUserFacingMessage(data), "assistant");
    return;
  }
  const changed = data.result?.status?.files?.length ?? 0;
  addBubble(
    changed
      ? `${changed} file(s) changed. Open "Check my app (free)" for full report.`
      : "No file changes right now.",
    "assistant",
    "What changed"
  );
};
document.getElementById("clearChat").onclick = () => {
  history = [];
  chatEl.innerHTML = "";
  addBubble("Chat cleared.", "assistant");
};

loadHealth();
loadReadyStatus();
addBubble(
  "Tell me what you want in normal words. If anything breaks, I will explain it in plain English and how to fix it.",
  "assistant"
);
