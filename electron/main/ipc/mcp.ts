import { ipcMain } from "electron";
import { getMcpClientConfigParams, getMcpStatus, restartMcpServer } from "@main/mcp/http";

/** 注册 MCP 服务状态与重启接口 */
export const registerMcpIpc = (): void => {
  ipcMain.handle("mcp:restart", () => restartMcpServer());
  ipcMain.handle("mcp:getStatus", () => getMcpStatus());
  ipcMain.handle("mcp:getClientConfigParams", () => getMcpClientConfigParams());
};
