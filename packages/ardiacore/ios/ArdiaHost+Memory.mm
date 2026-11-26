#import "ArdiaHost.h"

#include <cerrno>
#include <cstdint>
#include <iterator>
#include <limits>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <libproc.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

namespace {

std::optional<std::vector<kinfo_proc>> ProcessTable() {
  int selectors[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
  for (int attempt = 0; attempt < 3; ++attempt) {
    size_t size = 0;
    if (sysctl(selectors, std::size(selectors), nullptr, &size, nullptr, 0) != 0) return std::nullopt;
    std::vector<kinfo_proc> processes(size / sizeof(kinfo_proc) + 32);
    size = processes.size() * sizeof(kinfo_proc);
    if (sysctl(selectors, std::size(selectors), processes.data(), &size, nullptr, 0) == 0) {
      if (size % sizeof(kinfo_proc) != 0 || size > processes.size() * sizeof(kinfo_proc)) return std::nullopt;
      processes.resize(size / sizeof(kinfo_proc));
      return processes;
    }
    if (errno != ENOMEM) return std::nullopt;
  }
  return std::nullopt;
}

std::optional<uint64_t> ApplicationFootprint() {
  const auto processes = ProcessTable();
  if (!processes) return std::nullopt;
  const pid_t root = getpid();
  const kinfo_proc *browser = nullptr;
  std::unordered_map<pid_t, std::vector<const kinfo_proc *>> children;
  for (const auto &process : *processes) {
    const pid_t pid = process.kp_proc.p_pid;
    if (pid == root) browser = &process;
    else if (pid > 0 && process.kp_proc.p_stat != SZOMB) children[process.kp_eproc.e_ppid].push_back(&process);
  }
  if (!browser) return std::nullopt;

  uint64_t total = 0;
  std::vector<const kinfo_proc *> pending{browser};
  std::unordered_set<pid_t> seen;
  for (size_t index = 0; index < pending.size(); ++index) {
    const auto &process = *pending[index];
    const pid_t pid = process.kp_proc.p_pid;
    if (!seen.insert(pid).second) continue;

    rusage_info_v2 usage{};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V2, reinterpret_cast<rusage_info_t *>(&usage)) != 0) {
      if (pid != root && errno == ESRCH) continue;
      return std::nullopt;
    }
    if (pid != root && usage.ri_proc_exit_abstime != 0) continue;

    proc_bsdinfo identity{};
    const int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &identity, sizeof(identity));
    if (bytes != static_cast<int>(sizeof(identity))) {
      if (pid != root && bytes == 0 && errno == ESRCH) continue;
      return std::nullopt;
    }
    const auto &started = process.kp_proc.p_starttime;
    if (identity.pbi_pid != static_cast<uint32_t>(pid) ||
        identity.pbi_ppid != static_cast<uint32_t>(process.kp_eproc.e_ppid) ||
        identity.pbi_start_tvsec != static_cast<uint64_t>(started.tv_sec) ||
        identity.pbi_start_tvusec != static_cast<uint64_t>(started.tv_usec)) {
      if (pid == root) return std::nullopt;
      continue;
    }

    if (usage.ri_phys_footprint > std::numeric_limits<uint64_t>::max() - total) return std::nullopt;
    total += usage.ri_phys_footprint;
    const auto found = children.find(pid);
    if (found != children.end()) pending.insert(pending.end(), found->second.begin(), found->second.end());
  }
  return total;
}

}

@implementation ArdiaHost (Memory)

+ (NSNumber *)applicationMemoryFootprint {
  const auto bytes = ApplicationFootprint();
  return bytes ? @(*bytes) : nil;
}

@end
