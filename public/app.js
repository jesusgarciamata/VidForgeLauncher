const elements = {
  checkbox: document.querySelector("#energy-check"),
  status: document.querySelector("#status"),
  title: document.querySelector("#current-title"),
  jobId: document.querySelector("#job-id"),
  message: document.querySelector("#message"),
  error: document.querySelector("#error"),
  start: document.querySelector("#start"),
  retry: document.querySelector("#retry"),
  lastCheck: document.querySelector("#last-check"),
  nextCheck: document.querySelector("#next-check"),
  connection: document.querySelector("#connection"),
};

let currentProject = null;

const phaseLabels = {
  idle: "En espera",
  starting: "Iniciando",
  creating: "Creando job",
  syncing: "Sincronizando",
  monitoring: "Procesando",
  completing: "Finalizando",
  advancing: "Siguiente registro",
  halted: "Detenido",
};

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Sesión finalizada");
  }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function render(project) {
  currentProject = project;
  const phase = project.phase || "idle";
  elements.status.textContent = phaseLabels[phase] || phase;
  elements.status.className = `status status-${phase}`;
  elements.title.textContent = project.title || "Sin trabajo activo";
  elements.jobId.textContent = project.jobId ? `Job: ${project.jobId}` : "";
  elements.message.textContent = project.message || "";
  elements.error.hidden = !project.error;
  elements.error.textContent = project.error || "";
  elements.lastCheck.textContent = formatDate(project.lastCheckedAt) || "Todavía no realizada";
  elements.nextCheck.textContent = formatDate(project.nextCheckAt) || "Sin programar";

  const running = project.queueActive || project.busy;
  elements.start.disabled = running || project.halted;
  elements.checkbox.disabled = running || project.halted;
  elements.retry.hidden = !project.halted;
  elements.retry.disabled = project.busy;
}

async function refresh() {
  try {
    const body = await api("/api/projects", { method: "GET", headers: {} });
    render(body.projects[0]);
    elements.connection.textContent = "Conectado";
    elements.connection.classList.add("connection-ok");
  } catch (error) {
    elements.connection.textContent = "Sin conexión";
    elements.connection.classList.remove("connection-ok");
    elements.error.hidden = false;
    elements.error.textContent = error.message;
  }
}

elements.start.addEventListener("click", async () => {
  if (!elements.checkbox.checked) {
    elements.error.hidden = false;
    elements.error.textContent = "Selecciona Energy antes de iniciar.";
    elements.checkbox.focus();
    return;
  }
  elements.start.disabled = true;
  try {
    const body = await api("/api/projects/start", {
      method: "POST",
      body: JSON.stringify({ projectIds: ["energy"] }),
    });
    render(body.project);
  } catch (error) {
    elements.error.hidden = false;
    elements.error.textContent = error.message;
  } finally {
    await refresh();
  }
});

elements.retry.addEventListener("click", async () => {
  const accepted = confirm("Se reintentará manualmente el trabajo detenido. Confirma que quieres continuar.");
  if (!accepted) return;
  elements.retry.disabled = true;
  try {
    const body = await api("/api/projects/energy/retry", {
      method: "POST",
      body: "{}",
    });
    render(body.project);
  } catch (error) {
    elements.error.hidden = false;
    elements.error.textContent = error.message;
  } finally {
    await refresh();
  }
});

refresh();
setInterval(refresh, 15_000);
