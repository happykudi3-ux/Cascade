/**
 * Splits a total per-run candidate budget across multiple roles fairly,
 * so one role with a huge backlog doesn't starve the others every run.
 *
 * queues: [{ role: "Senior Backend Engineer", waiting: 12 }, ...]
 * totalBudget: e.g. 12
 * Returns: { "Senior Backend Engineer": 4, ... } — how many to take from each.
 *
 * Approach: give each role an equal base share first, then hand out
 * whatever's left over (because some roles had fewer waiting than their
 * base share) to roles that still have more waiting, in order, until the
 * budget or the backlog runs out.
 * Note: if there are ever more open roles than the total per-run budget
 * (e.g. 5+ simultaneous openings with a budget of 12), roles later in the
 * list can be shorted on leftover redistribution in a given run, though
 * every role still gets its base share every run. Not a concern at the
 * 2-3 simultaneous openings scale this was built for; worth revisiting
 * with a rotating priority order if that changes significantly.
 */
function allocateBudget(queues, totalBudget) {
  const allocation = {};
  const active = queues.filter((q) => q.waiting > 0);
  if (active.length === 0 || totalBudget <= 0) return allocation;

  const baseShare = Math.max(1, Math.floor(totalBudget / active.length));
  let remaining = totalBudget;

  for (const q of active) {
    const take = Math.min(q.waiting, baseShare, remaining);
    allocation[q.role] = take;
    remaining -= take;
  }

  if (remaining > 0) {
    for (const q of active) {
      if (remaining <= 0) break;
      const already = allocation[q.role] || 0;
      const more = Math.min(q.waiting - already, remaining);
      if (more > 0) {
        allocation[q.role] = already + more;
        remaining -= more;
      }
    }
  }

  return allocation;
}

module.exports = { allocateBudget };
