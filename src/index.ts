/**
 * 贝贝的美团 MCP V3
 * 用 cloudflare/workers-oauth-provider 官方 OAuth 库
 * 第 0 步：基础设施 + 三个测试工具 + 标准 OAuth
 *
 * OAuth 由 cloudflare 官方库实现 完全 spec-compliant
 * /authorize 自动通过 因为是 self-use 不需要真实用户认证
 */
import {
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { launch, type BrowserWorker } from "@cloudflare/playwright";
import { z } from "zod";

type Env = {
  BROWSER: BrowserWorker;
  MEITUAN_KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  MEITUAN_MCP: DurableObjectNamespace<MeituanMCP>;
  OAUTH_PROVIDER: OAuthHelpers;
};

// ============================================================
// MCP Server — 三个测试工具
// ============================================================

export class MeituanMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "meituan-mcp",
    version: "0.1.0",
  });

  async init() {
    // === Tool 1: ping ===
    this.server.tool(
      "ping",
      "测试 MCP 连通性",
      {},
      async () => ({
        content: [{ type: "text", text: "pong ✓ 贝贝的美团 MCP 在线" }],
      })
    );

    // === Tool 2: test_browser ===
    this.server.tool(
      "test_browser",
      "测试 Cloudflare Browser Rendering 能不能正常打开美团 H5",
      {},
      async () => {
        const browser = await launch(this.env.BROWSER);
        try {
          const page = await browser.newPage();
          await page.goto(
            "https://h5.waimai.meituan.com/waimai/mindex/home",
            { waitUntil: "domcontentloaded", timeout: 30000 }
          );
          const title = await page.title();
          const url = page.url();
          return {
            content: [
              {
                type: "text",
                text:
                  `浏览器服务正常 ✓\n\n` +
                  `页面标题：${title}\n` +
                  `实际 URL：${url}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `浏览器测试失败：${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
            isError: true,
          };
        } finally {
          await browser.close();
        }
      }
    );

    // === Tool 3: test_kv ===
    this.server.tool(
      "test_kv",
      "测试 KV 存储能不能读写",
      {
        value: z
          .string()
          .describe("要存的值（可选 不传就读取上次存的）")
          .optional(),
      },
      async ({ value }) => {
        const key = "test:beibei";
        if (value) {
          await this.env.MEITUAN_KV.put(key, value);
          return {
            content: [
              {
                type: "text",
                text: `KV 写入成功 ✓\n键：${key}\n值：${value}`,
              },
            ],
          };
        }
        const stored = await this.env.MEITUAN_KV.get(key);
        return {
          content: [
            {
              type: "text",
              text: stored
                ? `KV 读取成功 ✓\n键：${key}\n值：${stored}`
                : `KV 里还没存东西 给我传一个 value 试试`,
            },
          ],
        };
      }
    );
  }
}

// ============================================================
// Default handler — /authorize 自动 approve + 根路径状态页
// ============================================================

const defaultHandler = {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // --- /authorize: 自动通过（self-use 不需要真实用户认证）---
    if (url.pathname === "/authorize") {
      try {
        const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "beibei",
          metadata: { label: "贝贝" },
          scope:
            oauthReqInfo.scope && oauthReqInfo.scope.length > 0
              ? oauthReqInfo.scope
              : ["mcp"],
          props: { user: "beibei" },
        });

        return Response.redirect(redirectTo, 302);
      } catch (err) {
        return new Response(
          `Authorize error: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { status: 500 }
        );
      }
    }

    // --- 根路径状态页 ---
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `贝贝的美团 MCP V3 在线 ✓
（用 cloudflare/workers-oauth-provider 官方 OAuth 库）

可用端点：
  /sse    SSE transport（Claude.ai 用这个）
  /mcp    Streamable HTTP transport

OAuth 端点（库自动实现 spec-compliant）：
  /.well-known/oauth-protected-resource
  /.well-known/oauth-authorization-server
  /register   动态客户端注册
  /authorize  授权（self-use 自动通过）
  /token      令牌交换

三个测试工具：
  - ping              测试连通
  - test_browser      测试浏览器服务
  - test_kv           测试 KV 存储`,
        {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

// ============================================================
// Worker 入口 — OAuthProvider 包住一切
// ============================================================

export default new OAuthProvider({
  apiHandlers: {
    "/sse": MeituanMCP.serveSSE("/sse") as any,
    "/mcp": MeituanMCP.serve("/mcp") as any,
  },
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
});
