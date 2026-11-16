import { ApiError } from "./api-error.js";
import { requestJson } from "./http.js";

export function buildEnergyPayload(record) {
  const videoTitle = String(record.Title || "").trim();
  const customScript = String(record.Script || "").trim();
  const referenceThumbnailUrl = String(record["Thumb Reference URL"] || "").trim();

  if (!videoTitle) throw new ApiError("El registro no tiene Title", { code: "invalid_record" });
  if (!customScript) throw new ApiError("El registro no tiene Script", { code: "invalid_record" });
  if (!referenceThumbnailUrl) {
    throw new ApiError("El registro no tiene Thumb Reference URL", { code: "invalid_record" });
  }

  return {
    format: "Documentary",
    language: "English",
    videoTitle,
    customScript,
    voice: {
      method: "inworld",
      provider: "inworldOfficial",
      voiceId: "Craig",
      model: "inworld-tts-2",
      customVoiceUrl: null,
      voiceSettings: {
        speed: 1,
        deliveryMode: "BALANCED",
        textNormalization: "ON",
      },
    },
    referenceVideoUrl: null,
    referenceThumbnailUrl,
    cta: {
      enabled: false,
      position: null,
      channelName: null,
      channelLogoUrl: null,
    },
    folderId: "1b57a0f5-1a6a-4191-9095-77e1a7814098",
    channelId: null,
    generateThumbnail: null,
    voiceoverCleanupMode: null,
    animationStyle: "regular",
    storyCanvas: "auto",
    backgroundMusic: null,
    musicTrackIds: [],
    musicVibe: "",
    musicVolume: null,
    soundEffects: null,
    sfxVolume: null,
    model: "vidforge-fast-v1",
    editingStyle: null,
  };
}

export class VidForgeClient {
  constructor(config) {
    this.config = config;
  }

  headers() {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  async createJob(record) {
    const response = await requestJson(`${this.config.baseUrl}/api/v1/jobs`, {
      method: "POST",
      headers: this.headers(),
      body: buildEnergyPayload(record),
      timeoutMs: this.config.timeoutMs,
    });
    if (!response?.jobId) {
      throw new ApiError("VidForge aceptó la solicitud pero no devolvió jobId", {
        body: response,
        code: "missing_job_id",
      });
    }
    return response;
  }

  async getJob(jobId) {
    return requestJson(`${this.config.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
    });
  }

  async retryJob(jobId) {
    return requestJson(`${this.config.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
    });
  }
}
