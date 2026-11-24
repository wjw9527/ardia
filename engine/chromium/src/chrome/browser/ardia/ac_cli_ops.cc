// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_ops.h"

#include <limits>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "base/no_destructor.h"
#include "chrome/browser/ardia/ac_cli_devtools_sessions.h"
#include "chrome/browser/ardia/ac_engine.h"

namespace ardia {
namespace {

struct Op {
  std::string owner;
  base::OnceClosure cancel;
};

std::map<int, Op>& Ops() {
  static base::NoDestructor<std::map<int, Op>> ops;
  return *ops;
}

int Clamped(uint64_t count) {
  return count > static_cast<uint64_t>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(count);
}

}

EngineCliCounts& CliCounts() {
  static EngineCliCounts counts;
  return counts;
}

base::DictValue EngineCliTotals() {
  const EngineCliCounts& c = CliCounts();
  return base::DictValue()
      .Set("sessionsOpened", Clamped(c.sessions_opened))
      .Set("sessionsRefused", Clamped(c.sessions_refused))
      .Set("sessionCommands", Clamped(c.session_commands))
      .Set("sessionEvents", Clamped(c.session_events))
      .Set("sessionEventsCut", Clamped(c.session_events_cut))
      .Set("snapshots", Clamped(c.snapshots))
      .Set("snapshotsFailed", Clamped(c.snapshots_failed))
      .Set("snapshotRefs", Clamped(c.snapshot_refs))
      .Set("snapshotsModal", Clamped(c.snapshots_modal))
      .Set("occludedRefs", Clamped(c.occluded_refs))
      .Set("settles", Clamped(c.settles))
      .Set("settlesTimedOut", Clamped(c.settles_timed_out))
      .Set("settleMs", Clamped(c.settle_ms))
      .Set("hitTests", Clamped(c.hit_tests))
      .Set("clicks", Clamped(c.clicks))
      .Set("clicksBlocked", Clamped(c.clicks_blocked))
      .Set("dismissFound", Clamped(c.dismiss_found))
      .Set("refsRebound", Clamped(c.refs_rebound))
      .Set("refsStale", Clamped(c.refs_stale))
      .Set("screenshots", Clamped(c.screenshots))
      .Set("screenshotsHidden", Clamped(c.screenshots_hidden))
      .Set("screenshotsFailed", Clamped(c.screenshots_failed))
      .Set("cancelled", Clamped(c.cancelled))
      .Set("liveSessions", static_cast<int>(LiveCliDevToolsSessions()));
}

bool ValidCliOwner(std::string_view owner) {
  if (owner.empty() || owner.size() > 64) {
    return false;
  }
  for (char c : owner) {
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' ||
          c == ':')) {
      return false;
    }
  }
  return true;
}

int RegisterCliOp(std::string_view owner, base::OnceClosure cancel) {
  static int last = 0;
  const int id = ++last;
  Ops().emplace(id, Op{std::string(owner), std::move(cancel)});
  return id;
}

void FinishCliOp(int id) {
  Ops().erase(id);
}

int CancelCliOps(std::string_view owner) {
  std::vector<base::OnceClosure> cancels;
  for (auto it = Ops().begin(); it != Ops().end();) {
    if (it->second.owner == owner) {
      cancels.push_back(std::move(it->second.cancel));
      it = Ops().erase(it);
    } else {
      ++it;
    }
  }
  for (base::OnceClosure& cancel : cancels) {
    ++CliCounts().cancelled;
    std::move(cancel).Run();
  }
  return static_cast<int>(cancels.size()) + CloseCliDevToolsSessionsOf(owner);
}

}

AC_ARGS_CALL(ac_cli_cancel) {
  ardia::Reply out = call.TakeReply();
  const std::string owner = call.String("owner");
  if (!ardia::ValidCliOwner(owner)) {
    return out.Error("bad owner");
  }
  out.Send(base::DictValue().Set("cancelled", ardia::CancelCliOps(owner)));
}
