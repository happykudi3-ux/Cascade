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
