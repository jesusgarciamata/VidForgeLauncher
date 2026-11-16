import { ApiError } from "./api-error.js";
import { requestJson } from "./http.js";

export class NocoDbClient {
  constructor(config) {
    this.config = config;
  }

  recordsUrl() {
    const { baseUrl, apiVersion, baseId, tableId } = this.config;
    if (apiVersion === "v3") {
      return `${baseUrl}/api/v3/data/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/records`;
    }
    return `${baseUrl}/api/v2/tables/${encodeURIComponent(tableId)}/records`;
  }

  headers() {
    return { "xc-token": this.config.token };
  }

  normalizeRecord(record) {
    if (this.config.apiVersion === "v3") {
      return { Id: record.id, ...(record.fields || {}) };
    }
    return record;
  }

  async listByStatus(status, limit = 1) {
    const url = new URL(this.recordsUrl());
    url.searchParams.set("where", `(Status,eq,${status})`);
    url.searchParams.set("sort", "Id");
    url.searchParams.set("limit", String(limit));

    const result = await requestJson(url, {
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
    });
    const records = this.config.apiVersion === "v3"
      ? result?.records
      : result?.list;
    if (!Array.isArray(records)) {
      throw new ApiError("NocoDB devolvió un formato de lista no reconocido", {
        body: result,
        code: "invalid_nocodb_response",
      });
    }
    return records.map((record) => this.normalizeRecord(record));
  }

  async firstReady() {
    return (await this.listByStatus("Ready", 1))[0] || null;
  }

  async firstProcessing() {
    return (await this.listByStatus("Processing", 1))[0] || null;
  }

  async updateRecord(id, fields) {
    if (id === undefined || id === null || id === "") {
      throw new ApiError("No se puede actualizar NocoDB sin Id", { code: "missing_record_id" });
    }

    const body = this.config.apiVersion === "v3"
      ? [{ id, fields }]
      : [{ Id: id, ...fields }];

    return requestJson(this.recordsUrl(), {
      method: "PATCH",
      headers: this.headers(),
      body,
      timeoutMs: this.config.timeoutMs,
    });
  }
}
