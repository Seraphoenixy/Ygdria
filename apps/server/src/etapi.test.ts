import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { buildApp } from "./app.js";

describe("switch-controlled local ETAPI",()=>{
  let app:ReturnType<typeof buildApp>;
  let deviceToken:string;
  const headers={"x-ygdria-external-access":"1"};
  beforeAll(async()=>{
    app=buildApp({databaseUrl:":memory:",enableDeviceAuth:true,enableEtapi:true});
    const initialized=await app.inject({method:"POST",url:"/api/v1/devices/initialize",payload:{accessSalt:"test-access-salt",srpSalt:"test-srp-salt",verifier:"test-verifier",fileSalt:"test-file-salt",fileVerifier:"test-file-verifier",label:"test device"}});
    deviceToken=initialized.json().deviceToken;
    const enabled=await app.inject({method:"PATCH",url:"/api/v1/etapi/access",headers:{authorization:`Bearer ${deviceToken}`},payload:{enabled:true}});
    expect(enabled.statusCode).toBe(200);
  });
  afterAll(async()=>app.close());
  it("reads hierarchy, content and tags and edits with optimistic locking", async () => {
    const parentResponse = await app.inject({
      method: "POST",
      url: "/etapi/notes",
      headers,
      payload: {
        title: "AI parent",
        content: "# Parent content",
        tags: ["project"],
      },
    });
    expect(parentResponse.statusCode).toBe(201);
    const parent = parentResponse.json();
    expect(parent.content).toContain("Parent content");
    expect(parent.properties.tags).toEqual(["project"]);

    const childResponse = await app.inject({
      method: "POST",
      url: "/etapi/notes",
      headers,
      payload: {
        title: "AI child",
        parentPlacementId: parent.placements[0].placementId,
        content: "Initial",
        tags: ["draft"],
      },
    });
    expect(childResponse.statusCode).toBe(201);
    const child = childResponse.json();

    const parentPlacementId = parent.placements[0].placementId;
    const tree = (await app.inject({ url: `/etapi/tree/nodes/${parentPlacementId}/subtree?maxDepth=2`, headers })).json().items;
    expect(tree.map((item: any) => item.noteId)).toEqual([parent.id, child.id]);
    expect(
      tree.find((item: any) => item.noteId === child.id).parentPlacementId,
    ).toBe(parentPlacementId);
    const children = (await app.inject({ url: `/etapi/tree/nodes/${parentPlacementId}/children?limit=1`, headers })).json();
    expect(children.items).toHaveLength(1);
    expect(children.items[0].noteId).toBe(child.id);
    const resolved = (await app.inject({ url: "/etapi/tree/resolve?query=AI%20parent", headers })).json().items;
    expect(resolved).toEqual(expect.arrayContaining([expect.objectContaining({ placementId: parentPlacementId })]));

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/etapi/notes/${child.id}`,
      headers,
      payload: {
        expectedVersion: child.version,
        title: "AI child updated",
        content: "## Updated content",
        tags: ["reviewed", "project"],
      },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = updatedResponse.json();
    expect(updated.title).toBe("AI child updated");
    expect(updated.content).toContain("Updated content");
    expect(updated.properties.tags).toEqual(["reviewed", "project"]);

    const stale = await app.inject({
      method: "PATCH",
      url: `/etapi/notes/${child.id}`,
      headers,
      payload: { expectedVersion: child.version, title: "stale writer" },
    });
    expect(stale.statusCode).toBe(409);

    const byTag = (
      await app.inject({ url: "/etapi/search?tag=reviewed", headers })
    ).json().items;
    expect(byTag.some((item: any) => item.noteId === child.id)).toBe(true);

    const code = (
      await app.inject({
        method: "POST",
        url: "/etapi/notes",
        headers,
        payload: { title: "Source", type: "code", content: "const answer = 42;" },
      })
    ).json();
    const codeJson = await app.inject({
      url: `/etapi/notes/${code.id}/content?format=json`,
      headers,
    });
    expect(codeJson.headers["content-type"]).toContain("application/json");
    expect(codeJson.json()).toBe("const answer = 42;");
  });

  it("searches a placement subtree and applies atomic literal content edits", async () => {
    const root = (await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: { title: "Scoped root", content: "root body" },
    })).json();
    const child = (await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: {
        title: "Scoped child", parentPlacementId: root.placements[0].placementId,
        content: "unique subtree needle\nreplace this", tags: ["scoped-tag"],
      },
    })).json();
    await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: { title: "Outside", content: "unique subtree needle", tags: ["scoped-tag"] },
    });

    const scoped = (await app.inject({
      url: `/etapi/search?q=unique%20subtree%20needle&placementId=${root.placements[0].placementId}`,
      headers,
    })).json().items;
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ noteId: child.id, matchedPlacementIds: [child.placements[0].placementId] });
    const scopedTag = (await app.inject({
      url: `/etapi/search?tag=scoped-tag&placementId=${root.placements[0].placementId}`,
      headers,
    })).json().items;
    expect(scopedTag).toHaveLength(1);

    const preview = await app.inject({
      method: "PATCH", url: `/etapi/notes/${child.id}/content`, headers,
      payload: { expectedVersion: child.version, edits: [{ oldText: "replace this", newText: "replaced" }], dryRun: true },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ dryRun: true, matches: [1], content: expect.stringContaining("replaced") });
    expect((await app.inject({ url: `/etapi/notes/${child.id}/content`, headers })).body).toContain("replace this");

    const patched = await app.inject({
      method: "PATCH", url: `/etapi/notes/${child.id}/content`, headers,
      payload: { expectedVersion: child.version, edits: [{ oldText: "replace this", newText: "replaced" }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().content).toContain("replaced");
    expect((await app.inject({
      method: "PATCH", url: `/etapi/notes/${child.id}/content`, headers,
      payload: { expectedVersion: patched.json().version, edits: [{ oldText: "missing", newText: "anything" }] },
    })).statusCode).toBe(422);
  });

  it("creates and appends idempotently and rejects key reuse with changed parameters", async () => {
    const headers = {
      "x-ygdria-external-access": "1",
      "idempotency-key": "create-once",
    };
    const payload = { title: "Idempotent", content: "original" };
    const first = await app.inject({ method: "POST", url: "/etapi/notes", headers, payload });
    const second = await app.inject({ method: "POST", url: "/etapi/notes", headers, payload });
    expect(first.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(Object.keys(first.json()).sort()).toEqual(["id", "updatedAt", "version"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/etapi/notes",
          headers,
          payload: { ...payload, title: "different" },
        })
      ).statusCode,
    ).toBe(409);
    const id = first.json().id;
    const url = `/etapi/notes/${id}/operations`;
    const appendHeaders = { ...headers, "idempotency-key": "append-once" };
    const append = { operation: "append", text: "added" };
    const a = await app.inject({ method: "POST", url, headers: appendHeaders, payload: append });
    const b = await app.inject({ method: "POST", url, headers: appendHeaders, payload: append });
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    const note = (await app.inject({ url: `/etapi/notes/${id}`, headers })).json();
    expect(note.version).toBe(2);
    expect(note.content.match(/added/g)).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "x-ygdria-external-access": "1" },
          payload: append,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, "idempotency-key": "stale" },
          payload: { ...append, expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("combines keyword and tag filtering before limiting results, including Han search", async () => {
    const target = (
      await app.inject({
        method: "POST",
        url: "/etapi/notes",
        headers,
        payload: {
          title: "combinedneedle target",
          content: "combinedneedle 学习计划",
          tags: ["combined-tag"],
        },
      })
    ).json();
    for (let i = 0; i < 31; i++)
      await app.inject({
        method: "POST",
        url: "/etapi/notes",
        headers,
        payload: { title: `combinedneedle ${i}`, content: "combinedneedle 学习计划" },
      });
    for (const q of ["combinedneedle", "学习", "学习 combinedneedle"]) {
      const response = await app.inject({
        url: `/etapi/search?q=${encodeURIComponent(q)}&tag=combined-tag`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((n: any) => n.noteId)).toEqual([target.id]);
    }
  });

  it("defaults off, switches immediately, and cannot be enabled by external clients",async()=>{
    const local=buildApp({databaseUrl:":memory:",enableEtapi:true,localToken:"private"});
    const admin={"x-ygdria-local-token":"private"};
    try {
      expect((await local.inject({url:"/api/v1/etapi/access",headers:admin})).json()).toEqual({enabled:false});
      expect((await local.inject({url:"/etapi/tree/roots",headers})).statusCode).toBe(403);
      expect((await local.inject({method:"PATCH",url:"/api/v1/etapi/access",headers,payload:{enabled:true}})).statusCode).toBe(401);
      expect((await local.inject({method:"PATCH",url:"/api/v1/etapi/access",headers:admin,payload:{enabled:true}})).json()).toEqual({enabled:true});
      expect((await local.inject({url:"/etapi/tree/roots",headers})).statusCode).toBe(200);
      expect((await local.inject({url:"/api/v1/tree",headers})).statusCode).toBe(401);
      expect((await local.inject({method:"POST",url:"/api/v1/etapi/sessions",headers:admin,payload:{label:"retired"}})).statusCode).toBe(404);
      await local.inject({method:"PATCH",url:"/api/v1/etapi/access",headers:admin,payload:{enabled:false}});
      expect((await local.inject({url:"/etapi/tree/roots",headers})).statusCode).toBe(403);
    } finally {await local.close();}
  });
  it("rejects remote, browser, rebinding, and unmarked requests",async()=>{
    expect((await app.inject({url:"/etapi/tree/roots"})).statusCode).toBe(403);
    for(const extraHeaders of [{origin:"https://example.com"},{origin:"http://localhost:5173"},{host:"evil.example"},{"sec-fetch-site":"cross-site"}]) {
      expect((await app.inject({url:"/etapi/tree/roots",headers:{...headers,...extraHeaders}})).statusCode).toBe(403);
    }
    expect((await app.inject({url:"/etapi/tree/roots",headers,remoteAddress:"192.168.1.2"})).statusCode).toBe(403);
    expect((await app.inject({url:"/etapi/tree/roots",headers:{...headers,"x-forwarded-for":"127.0.0.1"},remoteAddress:"192.168.1.2"})).statusCode).toBe(403);
  });
  it("keeps the ETAPI and access management surface absent on standalone hosts",async()=>{
    const standalone=buildApp({databaseUrl:":memory:",enableEtapi:false});
    try {
      expect((await standalone.inject({url:"/etapi/tree/roots",headers})).statusCode).toBe(404);
      expect((await standalone.inject({url:"/api/v1/etapi/access"})).statusCode).toBe(404);
    } finally {await standalone.close();}
  });
  it("reads unique sections and returns actionable validation and conflict errors",async()=>{
    const note=(await app.inject({method:"POST",url:"/etapi/notes",headers,payload:{title:"section",content:"# Plan\n\nold\n\n# Other\n\nkeep"}})).json();
    const section=(await app.inject({url:`/etapi/notes/${note.id}/section?path=${encodeURIComponent(JSON.stringify(["Plan"]))}`,headers})).json();
    expect(section.version).toBe(1);
    const update=await app.inject({method:"POST",url:`/etapi/notes/${note.id}/operations`,headers,payload:{operation:"replace_section",headingPath:["Plan"],oldText:section.content,text:"new",expectedVersion:section.version}});
    expect(update.statusCode).toBe(200);expect(update.json().content).toContain("keep");
    const stale=await app.inject({method:"PATCH",url:`/etapi/notes/${note.id}`,headers,payload:{title:"stale",expectedVersion:1}});
    expect(stale.statusCode).toBe(409);expect(stale.json().error.currentVersion).toBe(2);
    const invalid=await app.inject({method:"PATCH",url:`/etapi/notes/${note.id}`,headers,payload:{title:"missing version"}});
    expect(invalid.json().error.validation).toContainEqual(expect.objectContaining({path:["expectedVersion"]}));
  });
  it("keeps protected notes redacted and refuses protected reads and writes",async()=>{
    const note=(await app.inject({method:"POST",url:"/etapi/notes",headers,payload:{title:"private",content:"secret"}})).json();
    const protectedResult=await app.inject({method:"PATCH",url:`/api/v1/notes/${note.id}/protected`,headers:{authorization:`Bearer ${deviceToken}`},payload:{protected:true,contentCiphertext:"v1.test-ciphertext"}});
    expect(protectedResult.statusCode).toBe(200);
    const node=(await app.inject({url:`/etapi/tree/nodes/${note.placements[0].placementId}`,headers})).json();
    expect(node).toMatchObject({title:"",isProtected:true});
    expect((await app.inject({url:`/etapi/notes/${note.id}`,headers})).statusCode).toBe(409);
    expect((await app.inject({method:"POST",url:`/etapi/notes/${note.id}/operations`,headers,payload:{operation:"tags",addTags:["denied"]}})).statusCode).toBe(409);
  });

  it("preserves links, task states and literal code through Markdown API read/write", async () => {
    const created = await app.inject({
      method: "POST", url: "/etapi/notes", headers,
      payload: {
        title: "Markdown fidelity",
        content: '# Integration\n\n[Driver](https://www.wch.cn/downloads/CH341SER_ZIP.html "official")\n\n- [x] Installed\n- [ ] Connected\n\n```js\nconst literal = "$x$ [[note:abc|literal]]";\n```',
      },
    });
    expect(created.statusCode).toBe(201);
    const noteId = created.json().id;
    const before = (await app.inject({ url: `/etapi/notes/${noteId}?format=json`, headers })).json();
    const exported = (await app.inject({ url: `/etapi/notes/${noteId}?format=markdown`, headers })).json();
    expect(exported.content).toContain("https://www.wch.cn/downloads/CH341SER_ZIP.html");
    expect(exported.content).toContain("- [x] Installed");
    const updated = await app.inject({
      method: "PATCH", url: `/etapi/notes/${noteId}`, headers,
      payload: { expectedVersion: before.version, content: exported.content },
    });
    expect(updated.statusCode).toBe(200);
    const after = (await app.inject({ url: `/etapi/notes/${noteId}?format=json`, headers })).json();
    expect(after.content).toEqual(before.content);
  });

  it("reports external changes independently of sync success",async()=>{
    const admin={authorization:`Bearer ${deviceToken}`};
    const readVersion=async()=> (await app.inject({url:"/api/v1/tree/version",headers:admin})).json().version;
    const before=await readVersion();
    const note=(await app.inject({method:"POST",url:"/etapi/notes",headers,payload:{title:"version signal"}})).json();
    const created=await readVersion();expect(created).toBeGreaterThan(before);
    await app.inject({method:"PATCH",url:`/etapi/notes/${note.id}`,headers,payload:{title:"renamed externally",expectedVersion:note.version}});
    const renamed=await readVersion();expect(renamed).toBeGreaterThan(created);
    await app.inject({method:"PATCH",url:`/etapi/placements/${note.placements[0].placementId}`,headers,payload:{parentPlacementId:"00000000-0000-4000-8000-000000000002",position:0}});
    expect(await readVersion()).toBeGreaterThan(renamed);
  });

});
