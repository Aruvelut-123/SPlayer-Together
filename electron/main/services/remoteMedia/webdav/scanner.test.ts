import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { scanWebDav } from "./scanner";
import type { WebDavRuntimeConfig } from "./types";

/**
 * 构建测试用 WebDAV 多状态响应
 * @param hrefs - 资源地址及目录标记
 * @returns DAV XML
 */
const createMultiStatus = (hrefs: Array<{ href: string; collection?: boolean }>): string => `
<d:multistatus xmlns:d="DAV:">
  ${hrefs
    .map(
      ({ href, collection }) => `<d:response>
    <d:href>${href}</d:href>
    <d:propstat><d:prop>
      <d:resourcetype>${collection ? "<d:collection/>" : ""}</d:resourcetype>
      <d:getcontentlength>321</d:getcontentlength>
      <d:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</d:getlastmodified>
      <d:getetag>etag</d:getetag>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>`,
    )
    .join("\n")}
</d:multistatus>`;

describe("WebDAV 有限深度扫描", () => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const resources = pathname.endsWith("/sub/")
      ? [
          { href: "/dav/music/sub/", collection: true },
          { href: "/dav/music/sub/child.FLAC" },
          { href: "/dav/music/sub/readme.txt" },
        ]
      : [
          { href: "/dav/music/", collection: true },
          { href: "/dav/music/root.mp3" },
          { href: "/dav/music/sub/", collection: true },
        ];
    response.writeHead(207, { "Content-Type": "application/xml" });
    response.end(createMultiStatus(resources));
  });
  let baseConfig: WebDavRuntimeConfig;

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseConfig = {
      id: "webdav-test",
      name: "WebDAV Test",
      url: `http://127.0.0.1:${address.port}/dav`,
      username: "",
      password: "",
      rootPath: "/music",
      scanDepth: 0,
    };
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("深度 0 只读取根目录音频", async () => {
    const records = await scanWebDav(baseConfig, () => false);
    assert.equal(records.length, 1);
    assert.equal(records[0].title, "root");
    assert.equal(records[0].relativePath, "root.mp3");
    assert.equal(records[0].contentLength, 321);
  });

  it("深度 1 读取一层子目录并忽略非音频", async () => {
    const records = await scanWebDav({ ...baseConfig, scanDepth: 1 }, () => false);
    assert.deepEqual(records.map((record) => record.relativePath).sort(), [
      "root.mp3",
      "sub/child.FLAC",
    ]);
  });
});
