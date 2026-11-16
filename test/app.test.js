import test from "node:test";
import assert from "node:assert/strict";
import { buildEnergyPayload } from "../src/vidforge.js";
import { NocoDbClient } from "../src/nocodb.js";
import { EnergyOrchestrator, completionStatus } from "../src/orchestrator.js";

const record = {
  Id: 7,
  Title: "Energy title",
  Script: "Complete script",
  "Thumb Reference URL": "https://www.youtube.com/watch?v=example",
  Status: "Ready",
  VidForgeJobId: null,
};

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("construye el payload Energy con los campos API y sin videoLengthMinutes", () => {
  const payload = buildEnergyPayload(record);
  assert.equal(payload.videoTitle, "Energy title");
  assert.equal(payload.customScript, "Complete script");
  assert.equal(payload.referenceThumbnailUrl, record["Thumb Reference URL"]);
  assert.equal(payload.voice.provider, "inworldOfficial");
  assert.equal(payload.folderId, "1b57a0f5-1a6a-4191-9095-77e1a7814098");
  assert.equal("videoLengthMinutes" in payload, false);
  assert.equal("customScriptEnabled" in payload, false);
});

test("rechaza un registro incompleto antes de llamar VidForge", () => {
  assert.throws(
    () => buildEnergyPayload({ ...record, Script: "" }),
    /no tiene Script/,
  );
});

test("forma el estado Done con día y mes", () => {
  assert.equal(
    completionStatus("America/Mexico_City", new Date("2026-11-15T18:00:00.000Z")),
    "Done 15/11",
  );
});

test("NocoDB v2 filtra Ready, ordena por Id y actualiza por PATCH", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if ((options?.method || "GET") === "PATCH") {
      return new Response('[{"Id":7}]', { status: 200 });
    }
    return new Response(JSON.stringify({ list: [record], pageInfo: {} }), { status: 200 });
  };

  try {
    const client = new NocoDbClient({
      baseUrl: "https://nocodb.example.com",
      token: "token",
      apiVersion: "v2",
      baseId: "base",
      tableId: "table",
      timeoutMs: 1_000,
    });
    assert.equal((await client.firstReady()).Id, 7);
    await client.updateRecord(7, { Status: "Processing", VidForgeJobId: "job-1" });

    const listUrl = new URL(requests[0].url);
    assert.equal(listUrl.pathname, "/api/v2/tables/table/records");
    assert.equal(listUrl.searchParams.get("where"), "(Status,eq,Ready)");
    assert.equal(listUrl.searchParams.get("sort"), "Id");
    assert.equal(requests[0].options.headers["xc-token"], "token");
    assert.deepEqual(JSON.parse(requests[1].options.body), [{
      Id: 7,
      Status: "Processing",
      VidForgeJobId: "job-1",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NocoDB v3 usa baseId y separa id de fields", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if ((options?.method || "GET") === "PATCH") {
      return new Response('{"records":[{"id":7,"fields":{}}]}', { status: 200 });
    }
    return new Response(JSON.stringify({
      records: [{ id: 7, fields: { Title: "Energy", Status: "Ready" } }],
      next: null,
    }), { status: 200 });
  };

  try {
    const client = new NocoDbClient({
      baseUrl: "https://nocodb.example.com",
      token: "token",
      apiVersion: "v3",
      baseId: "base-1",
      tableId: "table-1",
      timeoutMs: 1_000,
    });
    const found = await client.firstReady();
    assert.equal(found.Id, 7);
    assert.equal(found.Title, "Energy");
    await client.updateRecord(7, { Status: "Processing" });
    assert.equal(new URL(requests[0].url).pathname, "/api/v3/data/base-1/table-1/records");
    assert.deepEqual(JSON.parse(requests[1].options.body), [{
      id: 7,
      fields: { Status: "Processing" },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function memoryStore() {
  let value = null;
  return {
    async load() { return value; },
    async save(next) { value = structuredClone(next); },
  };
}

function fakeNoco(records) {
  return {
    async firstReady() {
      return records.filter((item) => item.Status === "Ready").sort((a, b) => a.Id - b.Id)[0] || null;
    },
    async firstProcessing() {
      return records.filter((item) => item.Status === "Processing").sort((a, b) => a.Id - b.Id)[0] || null;
    },
    async updateRecord(id, fields) {
      Object.assign(records.find((item) => item.Id === id), fields);
    },
  };
}

test("completa un job y continúa hasta que no existan Ready", async () => {
  const records = [{ ...record }];
  const orchestrator = new EnergyOrchestrator({
    nocodb: fakeNoco(records),
    vidforge: {
      async createJob() { return { jobId: "job-1", status: "queued" }; },
      async getJob() { return { id: "job-1", status: "completed" }; },
    },
    store: memoryStore(),
    pollIntervalMs: 60_000,
    timezone: "America/Mexico_City",
  });

  try {
    await orchestrator.start();
    await waitFor(() => orchestrator.state.phase === "monitoring");
    await orchestrator.poll();
    await waitFor(() => orchestrator.state.phase === "idle");
    assert.match(records[0].Status, /^Done \d{2}\/\d{2}$/);
    assert.equal(records[0].VidForgeJobId, "job-1");
  } finally {
    orchestrator.shutdown();
  }
});

test("failed detiene la cola y no procesa el siguiente Ready", async () => {
  const records = [{ ...record }, { ...record, Id: 8, Title: "Second" }];
  let created = 0;
  const orchestrator = new EnergyOrchestrator({
    nocodb: fakeNoco(records),
    vidforge: {
      async createJob() {
        created += 1;
        return { jobId: "job-1", status: "queued" };
      },
      async getJob() { return { id: "job-1", status: "failed" }; },
    },
    store: memoryStore(),
    pollIntervalMs: 60_000,
    timezone: "America/Mexico_City",
  });

  try {
    await orchestrator.start();
    await waitFor(() => orchestrator.state.phase === "monitoring");
    await orchestrator.poll();
    assert.equal(orchestrator.state.halted, true);
    assert.equal(records[0].Status, "Failed");
    assert.equal(records[1].Status, "Ready");
    assert.equal(created, 1);
  } finally {
    orchestrator.shutdown();
  }
});
