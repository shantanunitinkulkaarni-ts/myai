const RULES = [
  {
    match: /invalid json/i,
    what: "The AI replied in a format the tool could not read.",
    fix: "Click Send again with a shorter, clearer request. Or use 'Check my app (free)' for instant checks."
  },
  {
    match: /connection error|ECONNREFUSED|ETIMEDOUT|fetch failed/i,
    what: "The tool could not reach your AI provider (internet or API issue).",
    fix: "Check internet, confirm API key and base URL in .env, then restart the tool."
  },
  {
    match: /not a git repository/i,
    what: "This folder is not set up as a Git project yet.",
    fix: "Open terminal in your project folder and run: git init"
  },
  {
    match: /EADDRINUSE|address already in use/i,
    what: "Port 8787 is already in use by another copy of the tool.",
    fix: "Close the old tool window or stop the old server, then start again."
  },
  {
    match: /gcloud.*not found|'gcloud' is not recognized/i,
    what: "Google Cloud command tool (gcloud) is not installed.",
    fix: "Install Google Cloud CLI once, then run: gcloud auth login"
  },
  {
    match: /ENOENT|no such file/i,
    what: "A file or folder path was not found.",
    fix: "Check the file name/path exists in your project, then try again."
  },
  {
    match: /401|unauthorized|invalid api key/i,
    what: "API key was rejected (wrong or expired).",
    fix: "Update API_KEY in personal-coder-tool/.env and restart."
  },
  {
    match: /403|forbidden/i,
    what: "Permission denied for this action.",
    fix: "Check account access for GitHub/Google/API and try again."
  },
  {
    match: /npm ERR|command failed|exit code/i,
    what: "A build or command failed inside the project.",
    fix: "Read the fix steps below, then ask in chat: 'fix this build error step by step'."
  },
  {
    match: /push rejected|failed to push/i,
    what: "Git could not upload to GitHub.",
    fix: "Make sure you are logged into GitHub on this PC (Git Credential Manager), then try Save to GitHub again."
  },
  {
    match: /GCP_DEPLOY|deploy failed/i,
    what: "Publish to Google Cloud failed.",
    fix: "Run Check publish readiness, sign in with gcloud auth login, then try Publish again."
  },
  {
    match: /rg.*not found|findstr/i,
    what: "Code search tool had a problem (optional tool).",
    fix: "Ignore if everything else works, or install ripgrep (rg) for faster search."
  }
];

export function explainError(technical = "") {
  const text = String(technical || "Unknown error");
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return {
        plainEnglish: {
          whatHappened: rule.what,
          howToFix: rule.fix,
          technicalDetails: text.slice(0, 1500)
        }
      };
    }
  }
  return {
    plainEnglish: {
      whatHappened: "Something went wrong while running a technical step.",
      howToFix:
        "Copy the message below and ask in chat: 'explain this error in simple English and how to fix it'.",
      technicalDetails: text.slice(0, 1500)
    }
  };
}

export function explainToolFailure(action, result) {
  const tool = action?.tool || "unknown";
  const err = result?.error || JSON.stringify(result || {}).slice(0, 500);
  const base = explainError(err);

  const toolHints = {
    git_push: "Your code saved locally but did not upload. Check GitHub login.",
    git_add_commit: "Commit failed. Maybe no changes exist, or Git is not configured.",
    deploy_gcp: "Deploy failed. Use Check publish readiness first.",
    write_file: "Could not write file. Path may be wrong or permission blocked.",
    run_command: "A command failed. See details and ask chat to fix step by step."
  };

  if (toolHints[tool]) {
    base.plainEnglish.howToFix = `${toolHints[tool]} ${base.plainEnglish.howToFix}`;
  }

  return base.plainEnglish;
}

export function formatPlainEnglishBlock(plain) {
  if (!plain) return "";
  return [
    "——— In plain English ———",
    `What happened: ${plain.whatHappened}`,
    `How to fix: ${plain.howToFix}`,
    plain.technicalDetails ? `Technical details: ${plain.technicalDetails}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function attachPlainEnglish(payload, errorText) {
  const { plainEnglish } = explainError(errorText || payload?.error || payload?.assistantMessage);
  return {
    ...payload,
    ok: payload?.ok ?? false,
    plainEnglish,
    assistantMessage:
      payload?.assistantMessage ||
      formatPlainEnglishBlock(plainEnglish)
  };
}
