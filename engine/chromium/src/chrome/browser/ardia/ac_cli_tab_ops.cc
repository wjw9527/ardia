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
#include "chrome/browser/ardia/ac_cli_tab_ops.h"
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

using Kind = TabOpKind;
using OpArgs = TabOpArgs;

constexpr base::TimeDelta kOpDeadline = base::Seconds(15);
constexpr base::TimeDelta kTreeTimeout = base::Seconds(3);
constexpr size_t kTreeMaxNodes = 20000;
constexpr size_t kMaxOcclusionChecks = 40;
constexpr int kMaxHitDepth = 4;
constexpr int kMaxScrollTries = 4;

using Outcome = base::expected<base::DictValue, std::string>;


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

  ~TabOp() override {
    if (op_id_) {
      FinishCliOp(op_id_);
    }
  }

 private:
  TabOp(content::WebContents* contents, OpArgs args, Reply out)
      : content::WebContentsObserver(contents),
        args_(std::move(args)),
        out_(std::move(out)) {}

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

  void TargetHit(int hit) {
    RefStore::CreateForWebContents(web_contents());
    RefStore* refs = RefStore::FromWebContents(web_contents());
    base::DictValue out;
    out.Set("point", base::ListValue()
                         .Append(std::round(point_.x() * 10) / 10)
                         .Append(std::round(point_.y() * 10) / 10));
    out.Set("verified", hit >= 0);
    if (hit >= 0) {
      out.Set("hit", DescribeItem(*model_, refs, hit));
    }
    if (target_ >= 0) {
      out.Set("target", DescribeItem(*model_, refs, target_));
      if (rebound_) {
        out.Set("rebound", true);
      }
    }
    const int blocker = ReportBlocker(*model_, refs, hit, target_, &out);
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
    SnapshotRender render;
    render.scope = ScopeRoot();
    render.max_refs = args_.max_refs;
    render.max_text = args_.max_text;
    render.interactive_only = args_.interactive_only;
    render.occlusion = args_.occlusion;
    render.occlusion_unavailable = occlusion_unavailable_;
    render.checks = checks_.size();
    Finish(RenderSnapshot(*model_, RefStore::FromWebContents(web_contents()),
                          occluded_by_, render));
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

}

void StartTabOp(content::WebContents* contents, TabOpArgs args, Reply out) {
  TabOp::Start(contents, std::move(args), std::move(out));
}

}
