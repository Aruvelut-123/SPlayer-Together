import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { testWebDavConnection } from "./client";
import { parsePropfind } from "./parser";
import { createWebDavRootUrl, normalizeWebDavRootPath, resolveWebDavHref } from "./paths";
import type { WebDavRuntimeConfig } from "./types";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<ns0:multistatus xmlns:ns0="DAV:">
  <ns0:response>
    <ns0:href>/dav/%E9%9F%B3%E4%B9%90/</ns0:href>
    <ns0:propstat><ns0:prop><ns0:resourcetype><ns0:collection/></ns0:resourcetype></ns0:prop><ns0:status>HTTP/1.1 200 OK</ns0:status></ns0:propstat>
  </ns0:response>
  <ns0:response>
    <ns0:href>/dav/%E9%9F%B3%E4%B9%90/%E6%B5%8B%E8%AF%95%20%231.mp3</ns0:href>
    <ns0:propstat><ns0:prop><ns0:getetag>missing</ns0:getetag></ns0:prop><ns0:status>HTTP/1.1 404 Not Found</ns0:status></ns0:propstat>
    <ns0:propstat><ns0:prop><ns0:resourcetype/><ns0:getcontenttype>application/octet-stream</ns0:getcontenttype><ns0:getcontentlength>123</ns0:getcontentlength><ns0:getetag>valid</ns0:getetag></ns0:prop><ns0:status>HTTP/1.1 200 OK</ns0:status></ns0:propstat>
  </ns0:response>
</ns0:multistatus>`;

describe("WebDAV 路径与 XML", () => {
  const rootUrl = createWebDavRootUrl("https://example.com/dav", "/音乐");

  it("合并成功 propstat 并支持动态命名空间和中文 href", () => {
    const resources = parsePropfind(XML, rootUrl, rootUrl);
    assert.equal(resources.length, 2);
    assert.equal(resources[0].isCollection, true);
    assert.equal(resources[1].relativePath, "测试 #1.mp3");
    assert.equal(resources[1].contentLength, 123);
    assert.equal(resources[1].etag, "valid");
  });

  it("拒绝 DTD、跨 origin 和越过根目录的 href", () => {
    assert.throws(() => parsePropfind(`<!DOCTYPE x>${XML}`, rootUrl, rootUrl), /DTD/);
    assert.throws(
      () => resolveWebDavHref("https://other.example/song.mp3", rootUrl, rootUrl),
      /跨域/,
    );
    assert.throws(() => resolveWebDavHref("/dav/other/song.mp3", rootUrl, rootUrl), /根目录/);
    assert.throws(
      () =>
        parsePropfind(
          XML.replace('xmlns:ns0="DAV:"', 'xmlns:ns0="https://example.com/not-dav"'),
          rootUrl,
          rootUrl,
        ),
      /命名空间/,
    );
  });

  it("相对 href 以目录请求地址为基准解析", () => {
    const resolved = resolveWebDavHref("子目录/song.mp3", rootUrl, rootUrl);
    assert.equal(resolved.relativePath, "子目录/song.mp3");
    assert.equal(normalizeWebDavRootPath("/100% Music/#收藏"), "/100% Music/#收藏");
    assert.equal(normalizeWebDavRootPath(""), "/");
  });
});

describe("WebDAV 连接测试", () => {
  const requests: Array<{ method?: string; authorization?: string; range?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      range: request.headers.range,
    });
    if (request.headers.authorization !== "Basic dXNlcjpwYXNz") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "PROPFIND") {
      response.writeHead(207, { "Content-Type": "application/xml" }).end(XML);
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, { "Accept-Ranges": "bytes" }).end();
      return;
    }
    if (request.headers.range === "bytes=0-0") {
      response.writeHead(206, { "Content-Range": "bytes 0-0/123" }).end("x");
      return;
    }
    response.writeHead(500).end();
  });
  let config: WebDavRuntimeConfig;

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    config = {
      id: "test",
      name: "测试 WebDAV",
      url: `http://127.0.0.1:${address.port}/dav`,
      username: "user",
      password: "pass",
      rootPath: "/音乐",
      scanDepth: 0,
    };
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("预发送 Basic 并验证 HEAD 与 bytes=0-0", async () => {
    const result = await testWebDavConnection(config);
    assert.deepEqual(result, { ok: true, playbackVerified: true });
    assert.ok(requests.every((request) => request.authorization === "Basic dXNlcjpwYXNz"));
    assert.ok(requests.some((request) => request.method === "HEAD"));
    assert.ok(requests.some((request) => request.range === "bytes=0-0"));
  });
});
