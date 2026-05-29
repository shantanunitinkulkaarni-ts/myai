import dotenv from "dotenv";
import { existsSync } from "fs";

dotenv.config();

export const workspaceDir = process.env.WORKSPACE_DIR;
if (!workspaceDir) {
  console.error("WORKSPACE_DIR is required in .env");
  process.exit(1);
}
if (!existsSync(workspaceDir)) {
  console.error(`WORKSPACE_DIR not found: ${workspaceDir}`);
  process.exit(1);
}

export const port = Number(process.env.PORT || 8787);
export const SAVE_MODE = process.env.SAVE_MODE !== "false";
export const MAX_AGENT_LOOPS = Number(process.env.MAX_AGENT_LOOPS || (SAVE_MODE ? 4 : 8));
export const MAX_HISTORY_TURNS = Number(process.env.MAX_HISTORY_TURNS || 6);
export const GCP_DEPLOY_COMMAND = process.env.GCP_DEPLOY_COMMAND || "";
export const API_RETRY_COUNT = Number(process.env.API_RETRY_COUNT || 2);

export const models = {
  haiku: process.env.MODEL_HAIKU || "anthropic/claude-3.5-haiku",
  sonnet: process.env.MODEL_SONNET || "anthropic/claude-sonnet-4.6"
};

export const clientConfig = {
  apiKey: process.env.API_KEY,
  baseURL: process.env.API_BASE_URL
};
