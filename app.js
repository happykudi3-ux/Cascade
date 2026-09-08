(() => {
  const candidateList = document.getElementById("candidateList");
  const addCandidateBtn = document.getElementById("addCandidateBtn");
  const runBtn = document.getElementById("runBtn");
  const errorMsg = document.getElementById("errorMsg");
  const jobDescriptionEl = document.getElementById("jobDescription");
  const results = document.getElementById("results");
  const summaryBox = document.getElementById("summaryBox");
  const traceBox = document.getElementById("traceBox");
  const toggleTraceBtn = document.getElementById("toggleTraceBtn");
  const exportBtn = document.getElementById("exportBtn");
  const candidateTpl = document.getElementById("candidateInputTpl");

  let lastCandidates = [];

  function addCandidateRow() {
    const node = candidateTpl.content.cloneNode(true);
    const row = node.querySelector(".candidate-input");
    row.querySelector(".candidate-input__remove").addEventListener("click", () => {
      row.remove();
    });
    candidateList.appendChild(node);
  }

  addCandidateBtn.addEventListener("click", addCandidateRow);
  // start with two blank rows so the form doesn't look empty
  addCandidateRow();
  addCandidateRow();

  function collectCandidates() {
    return [...candidateList.querySelectorAll(".candidate-input")]
      .map((row) => ({
        name: row.querySelector(".candidate-input__name").value.trim(),
        resume_text: row.querySelector(".candidate-input__resume").value.trim(),
      }))
      .filter((c) => c.name && c.resume_text);
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.hidden = false;
  }
  function clearError() {
    errorMsg.hidden = true;
    errorMsg.textContent = "";
  }

  function renderTrace(trace) {
    traceBox.innerHTML = trace
      .map((t) => {
        const argSummary = t.args?.candidate_name ? ` (${t.args.candidate_name})` : "";
        return `<div class="trace__line"><span class="trace__step">[step ${t.step}]</span> ${t.tool}${argSummary} → ${JSON.stringify(t.result).slice(0, 160)}</div>`;
      })
      .join("");
  }

  function skillLine(matched, missing) {
    const m = (matched || []).slice(0, 4).join(", ") || "—";
    const g = (missing || []).slice(0, 3).join(", ") || "none";
    return `<span class="card__skills"><b>Matched:</b> ${escapeHtml(m)}<br/><b>Gaps:</b> ${escapeHtml(g)}</span>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderBoard(candidates) {
    const stages = ["scoring", "advanced", "flagged", "rejected"];
    const byStage = { scoring: [], advanced: [], flagged: [], rejected: [] };

    for (const c of candidates) {
      const stage = c.stage && byStage[c.stage] ? c.stage : "scoring";
      byStage[stage].push(c);
    }

    for (const stage of stages) {
      document.getElementById(`count-${stage}`).textContent = byStage[stage].length;
      const container = document.getElementById(`cards-${stage}`);
      container.innerHTML = byStage[stage]
        .map((c) => {
          const email = c.email
            ? `<details class="card__email"><summary>${c.stage === "advanced" ? "Draft invite" : c.stage === "rejected" ? "Draft decline" : "Reviewer note"}</summary><div class="card__email-body">${escapeHtml(c.email.subject)}\n\n${escapeHtml(c.email.body)}</div></details>`
            : "";
          return `<div class="card" data-stage="${c.stage || "scoring"}">
            <div class="card__top">
              <span class="card__name">${escapeHtml(c.name)}</span>
              <span class="card__score">${c.score ?? "—"}/100</span>
            </div>
            ${skillLine(c.matched, c.missing)}
            ${email}
          </div>`;
        })
        .join("");
    }
  }

  runBtn.addEventListener("click", async () => {
    clearError();
    const job_description = jobDescriptionEl.value.trim();
    const candidates = collectCandidates();

    if (!job_description) return showError("Add a job description first.");
    if (candidates.length === 0) return showError("Add at least one candidate with a name and resume.");
    if (candidates.length > 12) return showError("Cascade handles up to 12 candidates per run.");

    runBtn.disabled = true;
    runBtn.textContent = "Cascade is working…";
    results.hidden = true;

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_description, candidates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Agent run failed.");

      lastCandidates = data.candidates || [];
      renderBoard(lastCandidates);
      renderTrace(data.trace || []);
      traceBox.hidden = true;
      toggleTraceBtn.textContent = "Show agent trace";

      const s = data.summary;
      if (s) {
        summaryBox.innerHTML = `<strong>${escapeHtml(s.summary || "Run complete.")}</strong>
          <div class="summary__stats">
            <span class="stat"><span class="stat__n">${s.advanced_count ?? 0}</span> advanced</span>
            <span class="stat"><span class="stat__n">${s.flagged_count ?? 0}</span> flagged</span>
            <span class="stat"><span class="stat__n">${s.rejected_count ?? 0}</span> not progressing</span>
          </div>`;
      } else {
        summaryBox.textContent = "Run complete.";
      }

      results.hidden = false;
    } catch (err) {
      showError(err.message || "Something went wrong.");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run Cascade";
    }
  });

  toggleTraceBtn.addEventListener("click", () => {
    traceBox.hidden = !traceBox.hidden;
    toggleTraceBtn.textContent = traceBox.hidden ? "Show agent trace" : "Hide agent trace";
  });

  // ---------- automated intake panel ----------
  const autoBadge = document.getElementById("autoBadge");
  const applyLinkText = document.getElementById("applyLinkText");
  const copyApplyLinkBtn = document.getElementById("copyApplyLinkBtn");

  applyLinkText.textContent = `${window.location.origin}/apply.html`;
  copyApplyLinkBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(applyLinkText.textContent);
      copyApplyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyApplyLinkBtn.textContent = "Copy"), 1500);
    } catch {
      // clipboard API can fail on non-HTTPS/local contexts — text is still selectable manually
    }
  });

  const adminKeyInput = document.getElementById("adminKey");
  const scanNowBtn = document.getElementById("scanNowBtn");
  const downloadReportBtn = document.getElementById("downloadReportBtn");
  const scanStatus = document.getElementById("scanStatus");
  const recentRunsList = document.getElementById("recentRunsList");

  function timeAgo(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function renderRuns(runs) {
    if (!runs || runs.length === 0) {
      recentRunsList.innerHTML = '<p class="recent-runs__empty">No runs yet.</p>';
      return;
    }
    recentRunsList.innerHTML = runs
      .map((r) => {
        const detail = r.processed
          ? `${r.processed} processed${r.deferred ? `, ${r.deferred} deferred` : ""}`
          : (r.summary?.summary || "no new resumes");
        return `<div class="run-item">
          <span class="run-item__time">${timeAgo(r.timestamp)}</span>
          <span class="run-item__detail"><b>${escapeHtml(r.role || "")}</b> — ${escapeHtml(detail)}</span>
        </div>`;
      })
      .join("");
  }

  async function loadRecentRuns() {
    try {
      const res = await fetch("/api/recent-runs");
      const data = await res.json();
      if (!data.configured) {
        autoBadge.textContent = "not configured";
        autoBadge.dataset.state = "off";
        return;
      }
      autoBadge.textContent = "connected";
      autoBadge.dataset.state = "on";
      renderRuns(data.runs);
    } catch {
      autoBadge.textContent = "unavailable";
      autoBadge.dataset.state = "off";
    }
  }
  loadRecentRuns();

  scanNowBtn.addEventListener("click", async () => {
    scanNowBtn.disabled = true;
    scanStatus.removeAttribute("data-tone");
    scanStatus.textContent = "Scanning all open roles…";
    try {
      const headers = {};
      const key = adminKeyInput.value.trim();
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await fetch("/api/scan-folder", { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scan failed.");

      scanStatus.dataset.tone = "ok";
      if (!data.roles || data.roles.length === 0) {
        scanStatus.textContent = "Scan complete — no open roles found.";
      } else {
        scanStatus.textContent = data.roles
          .map((r) => `${r.role}: ${r.processed} processed${r.deferred ? `, ${r.deferred} waiting` : ""}`)
          .join("  •  ");
      }
      loadRecentRuns();
    } catch (err) {
      scanStatus.dataset.tone = "error";
      scanStatus.textContent = err.message || "Scan failed.";
    } finally {
      scanNowBtn.disabled = false;
    }
  });

  downloadReportBtn.addEventListener("click", async () => {
    downloadReportBtn.disabled = true;
    const originalText = downloadReportBtn.textContent;
    downloadReportBtn.textContent = "Building report…";
    try {
      const res = await fetch("/api/export-report");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not build report.");
      if (!data.candidates || data.candidates.length === 0) {
        scanStatus.dataset.tone = "error";
        scanStatus.textContent = "No processed candidates yet — run a scan first.";
        return;
      }
      const ws = XLSX.utils.json_to_sheet(data.candidates);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Cascade Full Report");
      XLSX.writeFile(wb, "cascade-full-report.xlsx");
    } catch (err) {
      scanStatus.dataset.tone = "error";
      scanStatus.textContent = err.message || "Could not build report.";
    } finally {
      downloadReportBtn.disabled = false;
      downloadReportBtn.textContent = originalText;
    }
  });

  exportBtn.addEventListener("click", () => {
    if (!lastCandidates.length) return;
    const rows = lastCandidates.map((c) => ({
      Name: c.name,
      Score: c.score ?? "",
      Stage: c.stage ?? "",
      "Matched requirements": (c.matched || []).join(", "),
      "Missing requirements": (c.missing || []).join(", "),
      "Drafted email subject": c.email?.subject || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cascade Run");
    XLSX.writeFile(wb, "cascade-pipeline-results.xlsx");
  });
})();
