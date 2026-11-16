import { ApiError } from "./api-error.js";

const WAITING_STATUSES = new Set(["queued", "running"]);
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled"]);

function isoNow() {
  return new Date().toISOString();
}

function completionStatus(timezone, date = new Date()) {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
  }).format(date);
  return `Done ${formatted}`;
}

export class EnergyOrchestrator {
  constructor({ nocodb, vidforge, store, pollIntervalMs, timezone }) {
    this.nocodb = nocodb;
    this.vidforge = vidforge;
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.timezone = timezone;
    this.timer = null;
    this.busy = false;
    this.state = this.emptyState();
  }

  emptyState() {
    return {
      id: "energy",
      name: "Energy",
      phase: "idle",
      queueActive: false,
      halted: false,
      stopReason: null,
      message: "Listo para iniciar",
      recordId: null,
      title: null,
      jobId: null,
      jobStatus: null,
      lastCheckedAt: null,
      nextCheckAt: null,
      error: null,
      updatedAt: isoNow(),
    };
  }

  publicState() {
    return { ...this.state, busy: this.busy };
  }

  async persist() {
    this.state.updatedAt = isoNow();
    await this.store.save({ version: 1, project: this.state, updatedAt: this.state.updatedAt });
  }

  async init() {
    const saved = await this.store.load();
    if (saved?.project?.id === "energy") {
      this.state = { ...this.emptyState(), ...saved.project };
    }

    if (this.state.halted) return;
    if (this.state.queueActive) {
      this.defer(() => this.runLoop(), 0);
      return;
    }

    try {
      const processing = await this.nocodb.firstProcessing();
      if (processing) {
        const jobId = String(processing.VidForgeJobId || "").trim();
        if (!jobId) {
          await this.halt("El registro Processing no tiene VidForgeJobId", "operational", processing);
          return;
        }
        this.state = {
          ...this.emptyState(),
          phase: "monitoring",
          queueActive: true,
          message: "Monitoreo recuperado después del reinicio",
          recordId: processing.Id,
          title: processing.Title || null,
          jobId,
          jobStatus: "unknown",
        };
        await this.persist();
        this.schedulePoll(0);
      }
    } catch (error) {
      await this.halt(`No se pudo recuperar el estado: ${error.message}`, "operational");
    }
  }

  async start() {
    if (this.busy || this.state.queueActive) {
      throw new ApiError("Energy ya está en ejecución", { status: 409, code: "already_running" });
    }
    if (this.state.halted) {
      throw new ApiError("Energy está detenido. Usa Reintentar antes de continuar", {
        status: 409,
        code: "project_halted",
      });
    }

    this.state.queueActive = true;
    this.state.phase = "starting";
    this.state.message = "Buscando el primer registro Ready";
    this.state.error = null;
    await this.persist();
    this.defer(() => this.runLoop(), 0);
    return this.publicState();
  }

  async runLoop() {
    if (this.busy || !this.state.queueActive || this.state.halted) return;
    this.busy = true;
    try {
      if (this.state.jobId && ["syncing", "monitoring"].includes(this.state.phase)) {
        if (this.state.phase === "syncing") {
          await this.nocodb.updateRecord(this.state.recordId, {
            Status: "Processing",
            VidForgeJobId: this.state.jobId,
          });
          this.state.phase = "monitoring";
          this.state.message = "Job creado. Esperando el siguiente control";
          await this.persist();
        }
        this.schedulePoll(this.pollIntervalMs);
        return;
      }

      const processing = await this.nocodb.firstProcessing();
      if (processing) {
        const jobId = String(processing.VidForgeJobId || "").trim();
        if (!jobId) {
          await this.halt("El registro Processing no tiene VidForgeJobId", "operational", processing);
          return;
        }
        this.state = {
          ...this.state,
          phase: "monitoring",
          recordId: processing.Id,
          title: processing.Title || null,
          jobId,
          jobStatus: "unknown",
          message: "Continuando el job que ya estaba Processing",
          error: null,
        };
        await this.persist();
        this.schedulePoll(0);
        return;
      }

      const record = await this.nocodb.firstReady();
      if (!record) {
        await this.finishQueue("No quedan registros Ready");
        return;
      }

      this.state = {
        ...this.state,
        phase: "creating",
        recordId: record.Id,
        title: record.Title || null,
        jobId: null,
        jobStatus: null,
        message: "Creando job en VidForge",
        error: null,
      };
      await this.persist();

      let created;
      try {
        created = await this.vidforge.createJob(record);
      } catch (error) {
        try {
          await this.nocodb.updateRecord(record.Id, { Status: "Failed" });
        } catch (updateError) {
          error.message = `${error.message}. Tampoco se pudo marcar Failed: ${updateError.message}`;
        }
        await this.halt(error.message, "submission", record);
        return;
      }

      this.state.phase = "syncing";
      this.state.jobId = created.jobId;
      this.state.jobStatus = created.status || "queued";
      this.state.message = "VidForge aceptó el job. Actualizando NocoDB";
      await this.persist();

      await this.nocodb.updateRecord(record.Id, {
        Status: "Processing",
        VidForgeJobId: created.jobId,
      });

      this.state.phase = "monitoring";
      this.state.message = "Job creado. Próxima consulta programada";
      await this.persist();
      this.schedulePoll(this.pollIntervalMs);
    } catch (error) {
      await this.halt(error.message, "operational");
    } finally {
      this.busy = false;
    }
  }

  schedulePoll(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    const next = new Date(Date.now() + delayMs);
    this.state.nextCheckAt = next.toISOString();
    this.persist().catch((error) => {
      console.error("No se pudo guardar nextCheckAt", error);
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poll().catch((error) => console.error("Error de polling", error));
    }, delayMs);
  }

  async poll() {
    if (this.busy || !this.state.queueActive || this.state.halted || !this.state.jobId) return;
    this.busy = true;
    try {
      const job = await this.vidforge.getJob(this.state.jobId);
      const status = String(job?.status || "").toLowerCase();
      this.state.lastCheckedAt = isoNow();
      this.state.nextCheckAt = null;
      this.state.jobStatus = status || "unknown";
      this.state.error = null;

      if (WAITING_STATUSES.has(status)) {
        this.state.message = `VidForge: ${status}. Próxima consulta en 5 minutos`;
        await this.persist();
        this.schedulePoll(this.pollIntervalMs);
        return;
      }

      if (status === "completed") {
        this.state.phase = "completing";
        this.state.message = "Job completado. Actualizando NocoDB";
        await this.persist();
        await this.nocodb.updateRecord(this.state.recordId, {
          Status: completionStatus(this.timezone),
        });

        this.state.phase = "advancing";
        this.state.message = "Job finalizado. Buscando el siguiente Ready";
        this.state.recordId = null;
        this.state.title = null;
        this.state.jobId = null;
        this.state.jobStatus = null;
        await this.persist();
        this.defer(() => this.runLoop(), 0);
        return;
      }

      if (FAILED_STATUSES.has(status)) {
        await this.nocodb.updateRecord(this.state.recordId, { Status: "Failed" });
        await this.halt(`VidForge terminó con estado ${status}. No se procesará el siguiente registro`, "terminal");
        return;
      }

      await this.halt(`VidForge devolvió un estado no reconocido: ${status || "vacío"}`, "operational");
    } catch (error) {
      this.state.lastCheckedAt = isoNow();
      this.state.error = error.message;
      if ([401, 403, 404].includes(error.status)) {
        await this.halt(error.message, "operational");
      } else {
        this.state.message = "La consulta falló. Se reintentará en el siguiente intervalo";
        await this.persist();
        this.schedulePoll(this.pollIntervalMs);
      }
    } finally {
      this.busy = false;
    }
  }

  async retry() {
    if (this.busy || this.state.queueActive) {
      throw new ApiError("Energy ya está en ejecución", { status: 409, code: "already_running" });
    }
    if (!this.state.halted) {
      throw new ApiError("Energy no está detenido", { status: 409, code: "not_halted" });
    }

    this.busy = true;
    try {
      const status = String(this.state.jobStatus || "").toLowerCase();
      if (this.state.stopReason === "terminal" && status === "failed" && this.state.jobId) {
        await this.vidforge.retryJob(this.state.jobId);
        await this.nocodb.updateRecord(this.state.recordId, {
          Status: "Processing",
          VidForgeJobId: this.state.jobId,
        });
        this.state.halted = false;
        this.state.stopReason = null;
        this.state.queueActive = true;
        this.state.phase = "monitoring";
        this.state.jobStatus = "queued";
        this.state.error = null;
        this.state.message = "Retry aceptado por VidForge";
        await this.persist();
        this.schedulePoll(this.pollIntervalMs);
        return this.publicState();
      }

      if (this.state.stopReason === "operational" && this.state.jobId) {
        this.state.halted = false;
        this.state.stopReason = null;
        this.state.queueActive = true;
        this.state.phase = "monitoring";
        this.state.error = null;
        this.state.message = "Monitoreo reanudado manualmente";
        await this.persist();
        this.schedulePoll(0);
        return this.publicState();
      }

      if (this.state.recordId) {
        await this.nocodb.updateRecord(this.state.recordId, {
          Status: "Ready",
          VidForgeJobId: null,
        });
      }
      this.state = {
        ...this.emptyState(),
        queueActive: true,
        phase: "starting",
        message: "Reintento manual solicitado",
      };
      await this.persist();
      this.defer(() => this.runLoop(), 0);
      return this.publicState();
    } finally {
      this.busy = false;
    }
  }

  async halt(message, reason, record = null) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = {
      ...this.state,
      phase: "halted",
      queueActive: false,
      halted: true,
      stopReason: reason,
      message: "Proceso detenido",
      recordId: record?.Id ?? this.state.recordId,
      title: record?.Title ?? this.state.title,
      nextCheckAt: null,
      error: message,
    };
    await this.persist();
  }

  async finishQueue(message) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state = { ...this.emptyState(), message };
    await this.persist();
  }

  defer(callback, delayMs) {
    setTimeout(() => {
      Promise.resolve(callback()).catch((error) => console.error("Error de tarea", error));
    }, delayMs);
  }

  shutdown() {
    if (this.timer) clearTimeout(this.timer);
  }
}

export { completionStatus };
