import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { workspaceDir } from "./config.js";

async function fileExists(rel) {
  return existsSync(path.join(workspaceDir, rel));
}

async function readText(rel) {
  return fs.readFile(path.join(workspaceDir, rel), "utf8");
}

export async function runAppAudit() {
  const lines = [];
  const push = (ok, label, detail) => lines.push({ ok, label, detail });

  push(true, "Project folder", workspaceDir);

  push(await fileExists("package.json"), "package.json", await fileExists("package.json") ? "found" : "missing");
  push(await fileExists("app"), "Next.js app folder", await fileExists("app") ? "found" : "missing");
  push(await fileExists(".env.local"), ".env.local", existsSync(path.join(workspaceDir, ".env.local")) ? "found (secrets configured)" : "missing — app may fail in production");
  push(await fileExists(".env.example"), ".env.example", await fileExists(".env.example") ? "found" : "missing");

  const routes = [];
  const apiDir = path.join(workspaceDir, "app", "api");
  if (existsSync(apiDir)) {
    const walk = async (dir, base = "") => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const rel = path.join(base, e.name);
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.name === "route.ts" || e.name === "route.js") {
          routes.push(`/api/${rel.replace(/\\/g, "/").replace(/\/route\.(ts|js)$/, "")}`);
        }
      }
    };
    await walk(apiDir);
    push(true, "API routes", routes.length ? routes.join(", ") : "none found");
  } else {
    push(false, "API routes", "app/api folder missing");
  }

  const pages = [];
  const appDir = path.join(workspaceDir, "app");
  if (existsSync(appDir)) {
    const walkPages = async (dir, base = "") => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const rel = path.join(base, e.name);
        if (e.isDirectory()) await walkPages(path.join(dir, e.name), rel);
        else if (e.name === "page.tsx" || e.name === "page.js") {
          const route = rel
            .replace(/\\/g, "/")
            .replace(/\/page\.(tsx|js)$/, "")
            .replace(/^\.$/, "");
          pages.push(route ? `/${route}` : "/");
        }
      }
    };
    await walkPages(appDir);
    push(true, "Pages", pages.join(", ") || "/");
  }

  try {
    const pkg = JSON.parse(await readText("package.json"));
    push(true, "App name", pkg.name || "unknown");
    push(Boolean(pkg.scripts?.build), "Build script", pkg.scripts?.build || "missing");
    push(Boolean(pkg.scripts?.dev), "Dev script", pkg.scripts?.dev || "missing");
  } catch {
    push(false, "package.json", "could not read");
  }

  let git = "unknown";
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(exec);
    const { stdout } = await run("git status -sb", { cwd: workspaceDir });
    git = stdout.trim();
    push(true, "Git status", git);
  } catch {
    push(false, "Git", "not a git repo or git not installed");
  }

  const okCount = lines.filter((l) => l.ok).length;
  const summary = `Checked ${lines.length} items: ${okCount} OK, ${lines.length - okCount} need attention.`;

  return { summary, lines };
}
