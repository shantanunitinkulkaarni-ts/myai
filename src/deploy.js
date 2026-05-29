import fs from "fs/promises";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { workspaceDir, GCP_DEPLOY_COMMAND } from "./config.js";
import { resolveSafePath } from "./tools.js";

const exec = promisify(execCb);

async function runCheck(command) {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: workspaceDir,
      windowsHide: true,
      timeout: 30000
    });
    return { ok: true, output: (stdout || stderr || "").trim() };
  } catch (error) {
    return { ok: false, output: String(error.message || error) };
  }
}

export async function getAutoDeployCommand() {
  if (GCP_DEPLOY_COMMAND?.trim()) return GCP_DEPLOY_COMMAND.trim();

  let service = "leadnest";
  let project = process.env.GOOGLE_CLOUD_PROJECT || "";

  try {
    const yamlPath = resolveSafePath("cloudrun.yaml");
    if (existsSync(yamlPath)) {
      const yaml = await fs.readFile(yamlPath, "utf8");
      const nameMatch = yaml.match(/^\s*name:\s*(\S+)/m);
      const projectMatch = yaml.match(/value:\s*(gen-lang-client-\d+)/);
      if (nameMatch) service = nameMatch[1];
      if (projectMatch) project = projectMatch[1];
    }
  } catch {
    // use defaults
  }

  if (!project) project = "gen-lang-client-0794202345";

  return `gcloud run deploy ${service} --source "${workspaceDir}" --project ${project} --region us-central1 --allow-unauthenticated --quiet`;
}

export async function getPublishReadiness() {
  const deployCommand = await getAutoDeployCommand();
  const gcloud = await runCheck("gcloud --version");
  const gcloudAuth = await runCheck("gcloud auth list --filter=status:ACTIVE --format=value(account)");
  const git = await runCheck("git status -sb");

  const items = [
    {
      id: "git",
      label: "Your code folder (Git)",
      ok: git.ok,
      detail: git.ok ? git.output : "Git not ready. Run git init in your project folder."
    },
    {
      id: "gcloud",
      label: "Google Cloud tool (gcloud)",
      ok: gcloud.ok,
      detail: gcloud.ok ? "Installed" : "Not installed. Install Google Cloud CLI once on this PC."
    },
    {
      id: "gcloud_auth",
      label: "Google login",
      ok: gcloudAuth.ok && gcloudAuth.output.length > 0,
      detail:
        gcloudAuth.ok && gcloudAuth.output.length > 0
          ? `Logged in as ${gcloudAuth.output.split("\n")[0]}`
          : "Not logged in. Run: gcloud auth login (one-time setup)."
    },
    {
      id: "deploy_command",
      label: "Deploy command (auto)",
      ok: Boolean(deployCommand),
      detail: deployCommand
    }
  ];

  const ready = items.every((i) => i.ok);

  return {
    ready,
    items,
    deployCommand,
    message: ready
      ? "You are ready to publish. Use the green buttons below (you will approve each step)."
      : "Some setup is still missing. The tool can guide you — you do not need to edit .env for deploy."
  };
}
