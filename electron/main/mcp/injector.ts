import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import type { McpAgentApp, McpClientConfigParams } from "@shared/types/settings";
import { nativeLog } from "@main/utils/logger";
import { isWin } from "@main/utils/config";

interface AgentDefinition {
  id: string;
  name: string;
  getConfigPath: () => string;
}

const getAppDataPath = () => app.getPath("appData");

const SUPPORTED_AGENTS: AgentDefinition[] = [
  {
    id: "claudecode",
    name: "Claude Code",
    getConfigPath: () => path.join(os.homedir(), ".claude.json"),
  },
  {
    id: "cursor",
    name: "Cursor",
    getConfigPath: () => path.join(os.homedir(), ".cursor", "mcp.json"),
  },
  {
    id: "claudedesktop",
    name: "Claude Desktop",
    getConfigPath: () => {
      if (isWin) {
        return path.join(getAppDataPath(), "Claude", "claude_desktop_config.json");
      }
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
    },
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    getConfigPath: () => path.join(os.homedir(), ".codebuddy", "mcp.json"),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    getConfigPath: () => path.join(os.homedir(), ".gemini", "config", "mcp.json"),
  },
];

/**
 * 探测本地已安装的 AI Agent 及配置状态
 */
export const detectMcpAgents = async (): Promise<McpAgentApp[]> => {
  const detected: McpAgentApp[] = [];

  for (const agent of SUPPORTED_AGENTS) {
    const configPath = agent.getConfigPath();
    try {
      const stats = await fs.stat(configPath);
      if (stats.isFile()) {
        const content = await fs.readFile(configPath, "utf-8");
        const json = JSON.parse(content || "{}");

        // 检查是否已经配置了 splayer-next
        const configured = !!json?.mcpServers?.["splayer-next"];

        detected.push({
          id: agent.id,
          name: agent.name,
          configPath,
          configured,
        });
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        nativeLog.warn(`Failed to read config for ${agent.name} at ${configPath}: ${e.message}`);
      }
    }
  }

  return detected;
};

/**
 * 将 SPlayer-Next 的 MCP 配置注入到目标 Agent 中
 */
export const injectMcpAgentConfig = async (
  agentId: string,
  params: McpClientConfigParams,
): Promise<boolean> => {
  const agent = SUPPORTED_AGENTS.find((a) => a.id === agentId);
  if (!agent) {
    throw new Error(`Unsupported agent: ${agentId}`);
  }

  const configPath = agent.getConfigPath();
  let json: any = {};

  try {
    const content = await fs.readFile(configPath, "utf-8");
    json = JSON.parse(content || "{}");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // 理论上不会发生，因为只有探测到了才会允许点击注入
      json = {};
    } else {
      throw new Error(`Failed to parse agent config: ${e.message}`);
    }
  }

  if (!json.mcpServers) {
    json.mcpServers = {};
  }

  json.mcpServers["splayer-next"] = {
    type: "http",
    url: `http://127.0.0.1:${params.port}/mcp`,
    headers: {
      "X-MCP-Key": params.accessKey,
    },
  };

  // 确保父目录存在
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(json, null, 2), "utf-8");

  return true;
};
