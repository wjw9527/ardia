// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/ardia/ac_cli_cdp.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/devtools/devtools_availability_checker.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "ui/accessibility/ax_mode.h"
#include "ui/accessibility/ax_tree_update.h"

namespace ardia {
namespace {

enum class Kind { kSnapshot, kHitTest, kClick };

constexpr base::TimeDelta kOpDeadline = base::Seconds(15);
constexpr base::TimeDelta kTreeTimeout = base::Seconds(3);
constexpr size_t kTreeMaxNodes = 20000;
constexpr size_t kMaxOcclusionChecks = 40;
constexpr int kMaxHitDepth = 4;
constexpr int kMaxScrollTries = 4;
constexpr size_t kDismissChoices = 4;

using Outcome = base::expected<base::DictValue, std::string>;

struct OpArgs {
  Kind kind = Kind::kSnapshot;
  std::string owner;
  size_t max_refs = 400;
  size_t max_text = 64 * 1024;
  bool interactive_only = false;
  bool whole_page = false;
  bool occlusion = true;
  std::string ref;
  std::optional<gfx::PointF> point;
  bool force = false;
  std::string button = "left";
  int click_count = 1;
  int modifiers = 0;
};

class TabOp : public content::WebContentsObserver {
 public:
  static void Start(content::WebContents* contents, OpArgs args, Reply out) {
    (new TabOp(contents, std::move(args), std::move(out)))->Begin();
  }

  void WebContentsDestroyed() override { Fail("the tab closed"); }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    Fail("the page's process went away");
  }

 private:
  TabOp(content::WebContents* contents, OpArgs args, Reply out)
      : content::WebContentsObserver(contents),
        args_(std::move(args)),
        out_(std::move(out)) {}

  ~TabOp() override {
    if (op_id_) {
      FinishCliOp(op_id_);
    }
  }

  void Begin() {
    content::WebContents* contents = web_contents();
    if (contents->GetBrowserContext()->IsOffTheRecord()) {
      return Fail("private tabs can't be read");
    }
    Profile* profile =
        Profile::FromBrowserContext(contents->GetBrowserContext());
    if (profile && !IsInspectionAllowed(profile, contents)) {
      return Fail("DevTools is turned off for this tab by your administrator");
    }
    switch (args_.kind) {
      case Kind::kSnapshot:
        ++CliCounts().snapshots;
        break;
      case Kind::kHitTest:
        ++CliCounts().hit_tests;
        break;
      case Kind::kClick:
        ++CliCounts().clicks;
        break;
    }
    if (!args_.owner.empty()) {
      op_id_ = RegisterCliOp(
          args_.owner,
          base::BindOnce(&TabOp::Fail, weak_factory_.GetWeakPtr(),
                         std::string("cancelled")));
    }
    deadline_.Start(FROM_HERE, kOpDeadline,
                    base::BindOnce(&TabOp::Fail, base::Unretained(this),
                                   std::string("the page didn't answer in "
                                               "time")));
    TakeTree();
  }

  void TakeTree() {
    content::WebContents* contents = web_contents();
    if (!contents || contents->IsBeingDestroyed()) {
      return Fail("the tab closed");
    }
    content::RenderWidgetHostView* view = contents->GetRenderWidgetHostView();
    const double dsf = view ? view->GetDeviceScaleFactor() : 1.0;
    const double zoom = blink::ZoomLevelToZoomFactor(
        content::HostZoomMap::GetZoomLevel(contents));
    scale_ = dsf * zoom;
    contents->RequestAXTreeSnapshot(
        base::BindOnce(&TabOp::GotTree, weak_factory_.GetWeakPtr()),
        ui::AXMode(ui::AXMode::kWebContents |
                   ui::AXMode::kExtendedProperties),
        kTreeMaxNodes, kTreeTimeout,
        content::WebContents::AXTreeSnapshotPolicy::kAll);
  }

  void GotTree(ui::AXTreeUpdate& update) {
    std::string error;
    std::optional<PageModel> model = BuildPageModel(update, scale_, &error);
    if (!model) {
      return Fail(error);
    }
    model_ = std::move(*model);
    model_->frames[0].token = web_contents()
                                  ->GetPrimaryMainFrame()
                                  ->GetDevToolsFrameToken()
                                  .ToString();
    model_->frames[0].local_root = model_->frames[0].token;
    model_->frames[0].reachable = true;
    scrolls_.clear();
    if (args_.kind == Kind::kSnapshot && !args_.occlusion &&
        model_->frames.size() == 1) {
      return FinishSnapshot();
    }
    if (!probe_) {
      return AttachProbe();
    }
    frame_cursor_ = 1;
    ResolveNextFrame();
  }

  void AttachProbe() {
    std::string error;
    probe_ = CdpSession::Attach(web_contents(), CdpAccess{}, &error);
    if (!probe_) {
      if (args_.kind == Kind::kSnapshot) {
        occlusion_unavailable_ = true;
        return FinishSnapshot();
      }
      return Fail(error);
    }
    probe_->SetEventSink(
        base::BindRepeating(&TabOp::ProbeEvent, weak_factory_.GetWeakPtr()));
    probe_->Send("Target.setAutoAttach",
                 base::DictValue()
                     .Set("autoAttach", true)
                     .Set("waitForDebuggerOnStart", false)
                     .Set("flatten", true),
                 base::BindOnce(&TabOp::AutoAttached,
                                weak_factory_.GetWeakPtr()));
  }

  void ProbeEvent(const std::string& method,
                  base::DictValue params,
                  const std::string& session_id,
                  size_t bytes) {
    if (method == "Target.attachedToTarget") {
      const std::string* child = params.FindString("sessionId");
      const base::DictValue* info = params.FindDict("targetInfo");
      const std::string* target = info ? info->FindString("targetId") : nullptr;
      const std::string* type = info ? info->FindString("type") : nullptr;
      if (child && target && type && *type == "iframe") {
        children_[*target] = *child;
      }
    } else if (method == "Target.detachedFromTarget") {
      const std::string* child = params.FindString("sessionId");
      for (auto it = children_.begin(); child && it != children_.end();) {
        it = it->second == *child ? children_.erase(it) : std::next(it);
      }
    }
  }

  void AutoAttached(CdpResult result) {
    frame_cursor_ = 1;
    ResolveNextFrame();
  }

  void ResolveNextFrame() {
    while (frame_cursor_ < model_->frames.size()) {
      AxFrame& frame = model_->frames[frame_cursor_];
      const AxFrame& parent = model_->frames[frame.parent];
      const AxItem& host = model_->items[frame.host];
      if (!frame.token.empty() || host.dom <= 0 || !parent.reachable) {
        ++frame_cursor_;
        continue;
      }
      probe_->Send(
          "DOM.describeNode", base::DictValue().Set("backendNodeId", host.dom),
          base::BindOnce(&TabOp::DescribedHost, weak_factory_.GetWeakPtr()),
          parent.session);
      return;
    }
    Proceed();
  }

  void DescribedHost(CdpResult result) {
    AxFrame& frame = model_->frames[frame_cursor_];
    const base::DictValue* node =
        result.has_value() ? result->FindDict("node") : nullptr;
    const std::string* token = node ? node->FindString("frameId") : nullptr;
    if (token) {
      frame.token = *token;
      content::RenderFrameHost* rfh = FrameFor(*token);
      while (rfh && rfh->GetParent() && !rfh->IsCrossProcessSubframe()) {
        rfh = rfh->GetParent();
      }
      if (rfh) {
        frame.local_root = rfh->GetDevToolsFrameToken().ToString();
        if (frame.local_root == model_->frames[0].token) {
          frame.session = std::string();
          frame.reachable = true;
        } else {
          auto child = children_.find(frame.local_root);
          frame.reachable = child != children_.end();
          frame.session = frame.reachable ? child->second : std::string();
        }
      }
    }
    ++frame_cursor_;
    ResolveNextFrame();
  }

  content::RenderFrameHost* FrameFor(const std::string& token) {
    content::RenderFrameHost* found = nullptr;
    web_contents()->GetPrimaryMainFrame()->ForEachRenderFrameHost(
        [&](content::RenderFrameHost* frame) {
          if (!found && frame->GetDevToolsFrameToken().ToString() == token) {
            found = frame;
          }
        });
    return found;
  }

  void Proceed() {
    switch (args_.kind) {
      case Kind::kSnapshot:
        return StartOcclusion();
      case Kind::kHitTest:
      case Kind::kClick:
        return LocateTarget();
    }
  }

  int ScopeRoot() const {
    return model_->modal >= 0 && !args_.whole_page ? model_->modal : 0;
  }

  void StartOcclusion() {
    if (!args_.occlusion || !probe_) {
      return FinishSnapshot();
    }
    const int scope = ScopeRoot();
    for (size_t i = 0; i < model_->items.size(); ++i) {
      const AxItem& item = model_->items[i];
      if (!item.interactive || item.hidden ||
          !model_->InViewport(static_cast<int>(i)) ||
          !model_->IsAncestor(scope, static_cast<int>(i))) {
        continue;
      }
      checks_.push_back(static_cast<int>(i));
      if (checks_.size() >= kMaxOcclusionChecks) {
        break;
      }
    }
    check_cursor_ = 0;
    NextOcclusion();
  }

  void NextOcclusion() {
    if (check_cursor_ >= checks_.size()) {
      return FinishSnapshot();
    }
    const int item = checks_[check_cursor_];
    HitAt(model_->ClickPoint(item),
          base::BindOnce(&TabOp::OcclusionHit, weak_factory_.GetWeakPtr(),
                         item));
  }

  void OcclusionHit(int item, int hit) {
    const int blocker = BlockerOf(*model_, hit, item);
    if (blocker >= 0) {
      occluded_by_[item] = blocker;
      ++CliCounts().occluded_refs;
    }
    ++check_cursor_;
    NextOcclusion();
  }

  using HitDone = base::OnceCallback<void(int)>;

  void HitAt(gfx::PointF point, HitDone done) {
    HitIn(0, point, 0, std::move(done));
  }

  void HitIn(int frame, gfx::PointF point, int depth, HitDone done) {
    const std::string session = model_->frames[frame].session;
    auto scroll = scrolls_.find(session);
    if (scroll != scrolls_.end()) {
      return Locate(frame, point, depth, scroll->second, std::move(done));
    }
    probe_->Send("Page.getLayoutMetrics", base::DictValue(),
                 base::BindOnce(&TabOp::GotMetrics, weak_factory_.GetWeakPtr(),
                                frame, point, depth, std::move(done)),
                 session);
  }

  void GotMetrics(int frame,
                  gfx::PointF point,
                  int depth,
                  HitDone done,
                  CdpResult result) {
    gfx::Vector2dF scroll;
    if (result.has_value()) {
      if (const base::DictValue* visual =
              result->FindDict("cssVisualViewport")) {
        scroll.set_x(visual->FindDouble("pageX").value_or(0));
        scroll.set_y(visual->FindDouble("pageY").value_or(0));
      }
    }
    scrolls_[model_->frames[frame].session] = scroll;
    Locate(frame, point, depth, scroll, std::move(done));
  }

  void Locate(int frame,
              gfx::PointF point,
              int depth,
              gfx::Vector2dF scroll,
              HitDone done) {
    const double x = std::round(point.x() + scroll.x());
    const double y = std::round(point.y() + scroll.y());
    if (!std::isfinite(x) || !std::isfinite(y) || std::abs(x) > 1e6 ||
        std::abs(y) > 1e6) {
      return std::move(done).Run(-1);
    }
    probe_->Send("DOM.getNodeForLocation",
                 base::DictValue()
                     .Set("x", static_cast<int>(x))
                     .Set("y", static_cast<int>(y))
                     .Set("includeUserAgentShadowDOM", false)
                     .Set("ignorePointerEventsNone", false),
                 base::BindOnce(&TabOp::Located, weak_factory_.GetWeakPtr(),
                                frame, point, depth, std::move(done)),
                 model_->frames[frame].session);
  }

  void Located(int frame,
               gfx::PointF point,
               int depth,
               HitDone done,
               CdpResult result) {
    if (!result.has_value()) {
      return std::move(done).Run(-1);
    }
    std::optional<int> node = result->FindInt("backendNodeId");
    const std::string* token = result->FindString("frameId");
    int in_frame = token ? model_->FrameWithToken(*token) : -1;
    if (in_frame < 0) {
      in_frame = frame;
    }
    const int item = node ? model_->Find(in_frame, *node) : -1;
    if (item < 0 || depth >= kMaxHitDepth) {
      return std::move(done).Run(item);
    }
    const int child = model_->items[item].frame_host
                          ? model_->ChildFrameOfHost(item)
                          : -1;
    if (child > 0 && model_->frames[child].reachable &&
        model_->frames[child].session != model_->frames[frame].session) {
      const gfx::PointF origin =
          model_->items[model_->frames[child].root].box.origin();
      return HitIn(child,
                   gfx::PointF(point.x() - origin.x(), point.y() - origin.y()),
                   depth + 1, std::move(done));
    }
    std::move(done).Run(item);
  }

  void LocateTarget() {
    if (!args_.ref.empty()) {
      RefStore::CreateForWebContents(web_contents());
      RefStore::Resolved resolved =
          RefStore::FromWebContents(web_contents())->Resolve(args_.ref,
                                                             *model_);
      if (resolved.item < 0) {
        ++CliCounts().refs_stale;
        return Fail(resolved.error);
      }
      if (resolved.rebound) {
        ++CliCounts().refs_rebound;
        rebound_ = true;
      }
      target_ = resolved.item;
      const AxItem& item = model_->items[target_];
      if (!model_->InViewport(target_) && scroll_tries_ < kMaxScrollTries &&
          item.dom > 0 && model_->frames[item.frame].reachable) {
        ++scroll_tries_;
        scrolled_ = true;
        return probe_->Send(
            "DOM.scrollIntoViewIfNeeded",
            base::DictValue().Set("backendNodeId", item.dom),
            base::BindOnce(&TabOp::Scrolled, weak_factory_.GetWeakPtr()),
            model_->frames[item.frame].session);
      }
      if (scrolled_ && last_box_ && (item.box.origin() - last_box_->origin())
                                            .Length() > 1.0f &&
          scroll_tries_ < kMaxScrollTries) {
        ++scroll_tries_;
        last_box_ = item.box;
        return Retake();
      }
      if (!model_->InViewport(target_)) {
        return Fail("the element isn't in view and couldn't be scrolled to");
      }
      point_ = model_->ClickPoint(target_);
    } else if (args_.point) {
      point_ = *args_.point;
    } else {
      return Fail("give a ref or a point");
    }
    HitAt(point_, base::BindOnce(&TabOp::TargetHit,
                                 weak_factory_.GetWeakPtr()));
  }

  void Scrolled(CdpResult result) {
    last_box_ = model_->items[target_].box;
    Retake();
  }

  void Retake() {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&TabOp::TakeTree, weak_factory_.GetWeakPtr()),
        base::Milliseconds(120));
  }

  base::DictValue Described(int item) {
    RefStore::CreateForWebContents(web_contents());
    RefStore* refs = RefStore::FromWebContents(web_contents());
    const AxItem& data = model_->items[item];
    base::DictValue out;
    out.Set("ref", refs->RefFor(*model_, item));
    out.Set("role", data.role);
    out.Set("name", data.name);
    out.Set("box", BoxValue(data.box));
    if (data.frame > 0) {
      out.Set("frame", data.frame);
    }
    return out;
  }

  void TargetHit(int hit) {
    base::DictValue out;
    out.Set("point", base::ListValue()
                         .Append(std::round(point_.x() * 10) / 10)
                         .Append(std::round(point_.y() * 10) / 10));
    out.Set("verified", hit >= 0);
    if (hit >= 0) {
      out.Set("hit", Described(hit));
    }
    if (target_ >= 0) {
      out.Set("target", Described(target_));
      if (rebound_) {
        out.Set("rebound", true);
      }
    }
    int blocker = -1;
    if (target_ >= 0) {
      blocker = BlockerOf(*model_, hit, target_);
    } else if (hit >= 0 && model_->modal >= 0 &&
               !model_->IsAncestor(model_->modal, hit)) {
      blocker = model_->modal;
    }
    out.Set("blocked", blocker >= 0);
    if (blocker >= 0) {
      base::DictValue layer = Described(blocker);
      out.Set("blocker", std::move(layer));
      std::vector<DismissChoice> choices =
          DismissChoices(*model_, blocker, kDismissChoices);
      if (choices.empty() && model_->modal >= 0 && blocker != model_->modal &&
          model_->IsAncestor(model_->modal, hit)) {
        choices = DismissChoices(*model_, model_->modal, kDismissChoices);
      }
      base::ListValue listed;
      for (const DismissChoice& choice : choices) {
        base::DictValue described = Described(choice.item);
        described.Set("kind", choice.kind);
        listed.Append(std::move(described));
      }
      if (!choices.empty()) {
        ++CliCounts().dismiss_found;
        out.Set("dismiss", listed.front().Clone());
      }
      out.Set("choices", std::move(listed));
    }
    if (args_.kind == Kind::kHitTest) {
      return Finish(std::move(out));
    }
    if (blocker >= 0 && !args_.force) {
      ++CliCounts().clicks_blocked;
      out.Set("clicked", false);
      return Finish(std::move(out));
    }
    result_ = std::move(out);
    Press("mouseMoved");
  }

  void Press(const std::string& type) {
    base::DictValue params;
    params.Set("type", type);
    params.Set("x", point_.x());
    params.Set("y", point_.y());
    params.Set("modifiers", args_.modifiers);
    if (type != "mouseMoved") {
      params.Set("button", args_.button);
      params.Set("clickCount", args_.click_count);
      params.Set("buttons", type == "mousePressed"
                                ? (args_.button == "right"    ? 2
                                   : args_.button == "middle" ? 4
                                                              : 1)
                                : 0);
    }
    probe_->Send("Input.dispatchMouseEvent", std::move(params),
                 base::BindOnce(&TabOp::Pressed, weak_factory_.GetWeakPtr(),
                                type));
  }

  void Pressed(std::string type, CdpResult result) {
    if (!result.has_value()) {
      return Fail("the click didn't reach the page: " +
                  ClippedUtf8(result.error(), 200));
    }
    if (type == "mouseMoved") {
      return Press("mousePressed");
    }
    if (type == "mousePressed") {
      return Press("mouseReleased");
    }
    result_.Set("clicked", true);
    Finish(std::move(result_));
  }

  void FinishSnapshot() {
    RefStore::CreateForWebContents(web_contents());
    RefStore* refs = RefStore::FromWebContents(web_contents());
    const PageModel& model = *model_;
    const int scope = ScopeRoot();
    base::ListValue listed;
    std::set<int> blockers;
    for (const auto& [item, blocker] : occluded_by_) {
      blockers.insert(blocker);
    }
    size_t bytes = 0;
    bool truncated = false;
    int interactive = 0;
    const int base_depth = model.items[scope].depth;
    for (size_t i = 0; i < model.items.size(); ++i) {
      const int index = static_cast<int>(i);
      const AxItem& item = model.items[i];
      if (item.hidden || !model.IsAncestor(scope, index)) {
        continue;
      }
      if (item.interactive) {
        ++interactive;
      }
      const bool blocker = blockers.contains(index);
      bool include = item.interactive || blocker;
      if (!include && !args_.interactive_only) {
        include = item.structural || item.frame_host ||
                  (item.text && !(item.parent >= 0 &&
                                  (model.items[item.parent].interactive ||
                                   model.items[item.parent].role ==
                                       "heading") &&
                                  model.items[item.parent].name == item.name));
      }
      if (!include) {
        continue;
      }
      if (listed.size() >= args_.max_refs || bytes >= args_.max_text) {
        truncated = true;
        break;
      }
      base::DictValue row;
      row.Set("ref", refs->RefFor(model, index));
      row.Set("role", item.text ? std::string("text") : item.role);
      if (!item.name.empty()) {
        row.Set("name", item.name);
      }
      if (!item.value.empty() && item.value != item.name) {
        row.Set("value", item.value);
      }
      row.Set("box", BoxValue(item.box));
      row.Set("depth", item.depth - base_depth);
      if (item.frame > 0) {
        row.Set("frame", item.frame);
      }
      if (item.disabled) {
        row.Set("disabled", true);
      }
      if (item.checked >= 0) {
        if (item.checked == 2) {
          row.Set("checked", "mixed");
        } else {
          row.Set("checked", item.checked == 1);
        }
      }
      if (item.expanded >= 0) {
        row.Set("expanded", item.expanded == 1);
      }
      if (item.focused) {
        row.Set("focused", true);
      }
      if (!model.InViewport(index)) {
        row.Set("offscreen", true);
      }
      if (item.interactive) {
        row.Set("fp", Fingerprint(item));
        if (item.dom > 0) {
          row.Set("node", item.dom);
        }
      }
      auto occluded = occluded_by_.find(index);
      if (occluded != occluded_by_.end()) {
        row.Set("occludedBy", refs->RefFor(model, occluded->second));
      }
      if (blocker) {
        row.Set("blocker", true);
      }
      bytes += item.name.size() + item.value.size() + 48;
      listed.Append(std::move(row));
    }
    CliCounts().snapshot_refs += listed.size();
    base::DictValue out;
    out.Set("generation", refs->generation());
    out.Set("viewport", base::ListValue()
                            .Append(std::round(model.viewport.width()))
                            .Append(std::round(model.viewport.height())));
    out.Set("scope", scope == 0 ? "page" : "modal");
    if (scope != 0) {
      ++CliCounts().snapshots_modal;
      base::DictValue modal;
      modal.Set("ref", refs->RefFor(model, scope));
      modal.Set("name", model.items[scope].name);
      out.Set("modal", std::move(modal));
    }
    if (model.focus >= 0 && !model.items[model.focus].hidden) {
      out.Set("focused", refs->RefFor(model, model.focus));
    }
    out.Set("refs", std::move(listed));
    out.Set("truncated", truncated);
    out.Set("counts", base::DictValue()
                          .Set("nodes", static_cast<int>(model.items.size()))
                          .Set("frames", static_cast<int>(model.frames.size()))
                          .Set("interactive", interactive)
                          .Set("occluded",
                               static_cast<int>(occluded_by_.size())));
    if (occlusion_unavailable_) {
      out.Set("occlusion", "unavailable");
    } else if (args_.occlusion) {
      out.Set("occlusion", static_cast<int>(checks_.size()));
    }
    Finish(std::move(out));
  }

  void Fail(const std::string& why) {
    if (args_.kind == Kind::kSnapshot) {
      ++CliCounts().snapshots_failed;
    }
    Finish(base::unexpected(why));
  }

  void Finish(Outcome outcome) {
    if (finished_) {
      return;
    }
    finished_ = true;
    deadline_.Stop();
    Observe(nullptr);
    if (outcome.has_value()) {
      out_.Send(std::move(outcome.value()));
    } else {
      out_.Error(outcome.error());
    }
    weak_factory_.InvalidateWeakPtrs();
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                               this);
  }

  OpArgs args_;
  Reply out_;
  int op_id_ = 0;
  bool finished_ = false;
  double scale_ = 1.0;
  std::optional<PageModel> model_;
  std::unique_ptr<CdpSession> probe_;
  std::map<std::string, std::string> children_;
  std::map<std::string, gfx::Vector2dF> scrolls_;
  size_t frame_cursor_ = 1;
  std::vector<int> checks_;
  size_t check_cursor_ = 0;
  std::map<int, int> occluded_by_;
  bool occlusion_unavailable_ = false;
  int target_ = -1;
  bool rebound_ = false;
  bool scrolled_ = false;
  int scroll_tries_ = 0;
  std::optional<gfx::RectF> last_box_;
  gfx::PointF point_;
  base::DictValue result_;
  base::OneShotTimer deadline_;
  base::WeakPtrFactory<TabOp> weak_factory_{this};
};

content::WebContents* TabFrom(const base::DictValue& args) {
  std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? TabWithId(*tab) : nullptr;
  return contents && !contents->IsBeingDestroyed() ? contents : nullptr;
}

bool ReadOwner(const ArgsCall& call, OpArgs* args, std::string* error) {
  args->owner = call.String("owner");
  if (!args->owner.empty() && !ValidCliOwner(args->owner)) {
    *error = "bad owner";
    return false;
  }
  return true;
}

bool ReadTarget(const ArgsCall& call, OpArgs* args, std::string* error) {
  args->ref = call.String("ref");
  if (args->ref.size() > 32) {
    *error = "bad ref";
    return false;
  }
  const std::optional<double> x = call.args().FindDouble("x");
  const std::optional<double> y = call.args().FindDouble("y");
  if (x.has_value() != y.has_value()) {
    *error = "give both x and y";
    return false;
  }
  if (x) {
    if (!std::isfinite(*x) || !std::isfinite(*y) || std::abs(*x) > 1e6 ||
        std::abs(*y) > 1e6) {
      *error = "that point is outside the page";
      return false;
    }
    args->point = gfx::PointF(*x, *y);
  }
  if (args->ref.empty() == !args->point.has_value()) {
    *error = "give a ref or a point (x, y), not both";
    return false;
  }
  return true;
}

}
}

AC_ARGS_CALL(ac_cli_snapshot) {
  ardia::Reply out = call.TakeReply();
  content::WebContents* contents = ardia::TabFrom(call.args());
  if (!contents) {
    return out.Error("no such tab");
  }
  ardia::OpArgs args;
  std::string error;
  if (!ardia::ReadOwner(call, &args, &error)) {
    return out.Error(error);
  }
  args.kind = ardia::Kind::kSnapshot;
  if (std::optional<int> limit = call.args().FindInt("maxRefs")) {
    if (*limit < 1 || *limit > 2000) {
      return out.Error("maxRefs must be 1 to 2000");
    }
    args.max_refs = static_cast<size_t>(*limit);
  }
  if (std::optional<int> limit = call.args().FindInt("maxTextBytes")) {
    if (*limit < 1024 || *limit > 512 * 1024) {
      return out.Error("maxTextBytes must be 1024 to 524288");
    }
    args.max_text = static_cast<size_t>(*limit);
  }
  args.interactive_only = call.Bool("interactiveOnly");
  args.whole_page = call.Bool("wholePage");
  args.occlusion = call.Bool("occlusion", true);
  ardia::TabOp::Start(contents, std::move(args), std::move(out));
}

AC_ARGS_CALL(ac_cli_hit_test) {
  ardia::Reply out = call.TakeReply();
  content::WebContents* contents = ardia::TabFrom(call.args());
  if (!contents) {
    return out.Error("no such tab");
  }
  ardia::OpArgs args;
  std::string error;
  if (!ardia::ReadOwner(call, &args, &error) ||
      !ardia::ReadTarget(call, &args, &error)) {
    return out.Error(error);
  }
  args.kind = ardia::Kind::kHitTest;
  ardia::TabOp::Start(contents, std::move(args), std::move(out));
}

AC_ARGS_CALL(ac_cli_click) {
  ardia::Reply out = call.TakeReply();
  content::WebContents* contents = ardia::TabFrom(call.args());
  if (!contents) {
    return out.Error("no such tab");
  }
  ardia::OpArgs args;
  std::string error;
  if (!ardia::ReadOwner(call, &args, &error) ||
      !ardia::ReadTarget(call, &args, &error)) {
    return out.Error(error);
  }
  args.kind = ardia::Kind::kClick;
  args.force = call.Bool("force");
  const std::string button = call.String("button");
  if (!button.empty()) {
    if (button != "left" && button != "right" && button != "middle") {
      return out.Error("button must be left, right or middle");
    }
    args.button = button;
  }
  if (std::optional<int> count = call.args().FindInt("clickCount")) {
    if (*count < 1 || *count > 3) {
      return out.Error("clickCount must be 1 to 3");
    }
    args.click_count = *count;
  }
  if (std::optional<int> modifiers = call.args().FindInt("modifiers")) {
    if (*modifiers < 0 || *modifiers > 15) {
      return out.Error("modifiers must be 0 to 15");
    }
    args.modifiers = *modifiers;
  }
  ardia::TabOp::Start(contents, std::move(args), std::move(out));
}
