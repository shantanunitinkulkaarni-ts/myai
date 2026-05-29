import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import simpleGit from "simple-git";
import { workspaceDir, GCP_DEPLOY_COMMAND } from "./config.js";
import { getAutoDeployCommand } from "./deploy.js";

const exec = promisify(execCb);

const MAJOR_COMMAND_MARKERS = [
  "git push",
  "git commit",
  "deploy",
  "gcloud",
  "terraform",
  "kubectl",
  "docker push",
  "rm -rf",
  "del /s",
  "shutdown",
  "format "
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".vercel"]);

export function resolveSafePath(relativePath) {
  const normalized = path.normalize(relativePath || "").replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.resolve(workspaceDir, normalized);
  if (!full.startsWith(path.resolve(workspaceDir))) {
    throw new Error("Path escapes WORKSPACE_DIR");
  }
  return full;
}

export async function getProjectContext() {
  const parts = [];
  for (const file of ["package.json", "README.md"]) {
    try {
      const full = resolveSafePath(file);
      const text = await fs.readFile(full, "utf8");
      parts.push(`${file}:\n${text.slice(0, 1200)}`);
    } catch {
      // ignore missing
    }
  }
  return parts.join("\n\n") || "No package.json/README found.";
}

export async function previewWrite(action) {
  const fullPath = resolveSafePath(action.path);
  const next = action.content || "";
  if (!existsSync(fullPath)) {
    return { type: "create", path: action.path, preview: next.slice(0, 4000) };
  }
  const prev = await fs.readFile(fullPath, "utf8");
  
  if (action.tool === "replace_in_file") {
    return {
      type: "update_blocks",
      path: action.path,
      blocks: action.replace_blocks
    };
  }

  return {
    type: "update",
    path: action.path,
    previousLines: prev.split("\n").length,
    nextLines: next.split("\n").length,
    previousPreview: prev.slice(0, 2000),
    nextPreview: next.slice(0, 2000)
  };
}

async function runShell(command) {
  const { stdout, stderr } = await exec(command, {
    cwd: workspaceDir,
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 10 * 1024 * 1024, // 10MB to avoid crashing on large outputs
    env: process.env
  });
  
  // Truncate output to save tokens and prevent huge JSON blocks
  const maxOutputLen = 8000;
  const out = stdout || "";
  const err = stderr || "";
  
  return { 
    stdout: out.length > maxOutputLen ? out.slice(0, maxOutputLen) + "... (truncated)" : out,
    stderr: err.length > maxOutputLen ? err.slice(0, maxOutputLen) + "... (truncated)" : err
  };
}

async function searchCode(pattern) {
  const safe = pattern.replace(/"/g, '\\"');
  try {
    return await runShell(`rg -n --max-count 50 "${safe}" .`);
  } catch {
    return await runShell(`findstr /S /N /I "${safe.replace(/[.*+?^${}()|[\]\\]/g, "")}" *.ts *.tsx *.js *.jsx *.json *.md 2>nul`);
  }
}

async function listFiles(subdir = ".", depth = 2) {
  const root = resolveSafePath(subdir);
  const results = [];

  async function walk(dir, level) {
    if (level > depth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspaceDir, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        await walk(full, level + 1);
      } else {
        results.push(rel);
      }
    }
  }

  await walk(root, 0);
  return results.slice(0, 200);
}

export function needsApproval(action) {
  if (!action?.tool) return false;
  if (["write_file", "replace_in_file", "git_add_commit", "git_push"].includes(action.tool)) {
    return true;
  }
  if (action.tool === "run_command") {
    const cmd = (action.command || "").toLowerCase();
    return MAJOR_COMMAND_MARKERS.some((marker) => cmd.includes(marker));
  }
  return false;
}

export async function runTool(action) {
  try {
    switch (action.tool) {
      case "list_files":
        return { ok: true, files: await listFiles(action.path || ".", Number(action.depth || 2)) };
      case "read_file": {
        const fullPath = resolveSafePath(action.path);
        const content = await fs.readFile(fullPath, "utf8");
        const lines = content.split("\n");
        let resultLines = lines;
        const start = action.start_line ? Math.max(1, action.start_line) - 1 : 0;
        const end = action.end_line ? Math.min(lines.length, action.end_line) : lines.length;
        if (start > 0 || end < lines.length) {
          resultLines = lines.slice(start, end);
        }
        const text = resultLines.join("\n");
        return { 
          ok: true, 
          content: text.slice(0, 20000), 
          totalLines: lines.length, 
          showingLines: `${start + 1}-${end}` 
        };
      }
      case "replace_in_file": {
        const fullPath = resolveSafePath(action.path);
        let content = existsSync(fullPath) ? await fs.readFile(fullPath, "utf8") : "";
        
        if (action.replace_blocks && Array.isArray(action.replace_blocks)) {
          for (const block of action.replace_blocks) {
            if (content.includes(block.search)) {
               content = content.replace(block.search, block.replace);
            } else {
               return { ok: false, error: `Search block not found exactly in file. Ensure exact whitespace and line breaks.` };
            }
          }
        } else if (action.content !== undefined) {
           content = action.content; // Fallback for full rewrite if creating a new file
        }
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf8");
        return { ok: true, message: `Updated ${action.path}` };
      }
      case "write_file": {
        const fullPath = resolveSafePath(action.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, action.content || "", "utf8");
        return { ok: true, message: `Wrote ${action.path}` };
      }
      case "search_code":
        return { ok: true, ...(await searchCode(action.pattern || "")) };
      case "run_command":
        return { ok: true, ...(await runShell(action.command || "")) };
      case "git_status": {
        const git = simpleGit({ baseDir: workspaceDir });
        return { ok: true, status: await git.status() };
      }
      case "git_diff": {
        const git = simpleGit({ baseDir: workspaceDir });
        return { ok: true, diff: (await git.diff()).slice(0, 20000) };
      }
      case "git_log": {
        const git = simpleGit({ baseDir: workspaceDir });
        const log = await git.log({ maxCount: Number(action.max || 10) });
        return { ok: true, log };
      }
      case "git_add_commit": {
        const git = simpleGit({ baseDir: workspaceDir });
        await git.add(action.paths || ".");
        const commit = await git.commit(action.message || "update");
        return { ok: true, commit };
      }
      case "git_push": {
        const git = simpleGit({ baseDir: workspaceDir });
        const push = await git.push();
        return { ok: true, push };
      }
      case "deploy_gcp": {
        const cmd = await getAutoDeployCommand();
        return { ok: true, command: cmd, ...(await runShell(cmd)) };
      }
      default:
        return { ok: false, error: `Unknown tool: ${action.tool}` };
    }
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

export async function getWorkspaceInfo() {
  const git = simpleGit({ baseDir: workspaceDir });
  let gitInfo = { isRepo: false };
  try {
    const status = await git.status();
    const remotes = await git.getRemotes(true);
    gitInfo = {
      isRepo: true,
      branch: status.current,
      changed: status.files.length,
      remotes: remotes.map((r) => r.refs.fetch || r.refs.push).filter(Boolean)
    };
  } catch {
    gitInfo = { isRepo: false };
  }

  return {
    workspaceDir,
    git: gitInfo,
    deployConfigured: true,
    deployAuto: !GCP_DEPLOY_COMMAND
  };
}
