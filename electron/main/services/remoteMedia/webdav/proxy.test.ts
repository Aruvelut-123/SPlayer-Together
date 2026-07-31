import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { closeWebDavProxy, createWebDavProxyUrl } from "./proxy";
import type { WebDavRuntimeConfig } from "./types";

describe("WebDAV loopback 播放代理", () => {
  const received: Array<{ method?: string; url?: string; authorization?: string; range?: string }> =
    [];
  const upstream = createServer((request, response) => {
    received.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      range: request.headers.range,
    });
    if (request.method === "HEAD") {
      response.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": "4" }).end();
      return;
    }
    response
      .writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Range": "bytes 0-0/4",
        "Content-Length": "1",
      })
      .end("a");
  });
  let config: WebDavRuntimeConfig;

  before(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;
    config = {
      id: "proxy-test",
      name: "Proxy Test",
      url: `http://127.0.0.1:${address.port}/dav`,
      username: "user",
      password: "pass",
      rootPath: "/music",
      scanDepth: 0,
    };
  });

  after(async () => {
    closeWebDavProxy();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("隐藏上游地址并流式转发 HEAD 和 Range", async () => {
    const proxyUrl = await createWebDavProxyUrl(config, "子目录/song.mp3");
    assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+\/[a-f\d]{32}$/);
    assert.equal(proxyUrl.includes("song.mp3"), false);

    const head = await fetch(proxyUrl, { method: "HEAD" });
    assert.equal(head.status, 200);
    const ranged = await fetch(proxyUrl, { headers: { Range: "bytes=0-0" } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), "a");
    assert.ok(received.every((request) => request.authorization === "Basic dXNlcjpwYXNz"));
    assert.ok(received.some((request) => request.range === "bytes=0-0"));
    assert.ok(
      received.every(
        (request) => request.url === "/dav/music/%E5%AD%90%E7%9B%AE%E5%BD%95/song.mp3",
      ),
    );
  });
});
