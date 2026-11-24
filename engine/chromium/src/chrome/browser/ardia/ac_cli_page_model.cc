// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_page_model.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <string_view>
#include <tuple>
#include <utility>

#include "base/hash/hash.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/accessibility/ax_enum_util.h"
#include "ui/accessibility/ax_enums.mojom.h"
#include "ui/accessibility/ax_node.h"
#include "ui/accessibility/ax_tree.h"
#include "ui/accessibility/ax_tree_update.h"

namespace ardia {
namespace {

using ax::mojom::Role;

constexpr size_t kMaxNameBytes = 200;
constexpr size_t kMaxFrames = 24;
constexpr size_t kMaxRefEntries = 4000;
constexpr size_t kRefTrim = 1000;

bool IsInteractiveRole(Role role) {
  switch (role) {
    case Role::kButton:
    case Role::kCheckBox:
    case Role::kComboBoxGrouping:
    case Role::kComboBoxMenuButton:
    case Role::kComboBoxSelect:
    case Role::kDisclosureTriangle:
    case Role::kDisclosureTriangleGrouped:
    case Role::kLink:
    case Role::kListBoxOption:
    case Role::kMenuItem:
    case Role::kMenuItemCheckBox:
    case Role::kMenuItemRadio:
    case Role::kMenuListOption:
    case Role::kPopUpButton:
    case Role::kRadioButton:
    case Role::kSearchBox:
    case Role::kSlider:
    case Role::kSpinButton:
    case Role::kSwitch:
    case Role::kTab:
    case Role::kTextField:
    case Role::kTextFieldWithComboBox:
    case Role::kToggleButton:
    case Role::kTreeItem:
    case Role::kColorWell:
    case Role::kDate:
    case Role::kDateTime:
    case Role::kInputTime:
      return true;
    default:
      return false;
  }
}

bool IsStructuralRole(Role role, bool named) {
  switch (role) {
    case Role::kHeading:
    case Role::kDialog:
    case Role::kAlertDialog:
    case Role::kAlert:
    case Role::kMain:
    case Role::kNavigation:
    case Role::kBanner:
    case Role::kContentInfo:
    case Role::kSearch:
    case Role::kComplementary:
      return true;
    case Role::kForm:
    case Role::kRegion:
    case Role::kImage:
    case Role::kFigure:
      return named;
    default:
      return false;
  }
}

std::string Lowered(const std::string& text) {
  return base::ToLowerASCII(base::TrimWhitespaceASCII(text, base::TRIM_ALL));
}

bool Contains(const std::string& text, std::string_view part) {
  return text.find(part) != std::string::npos;
}

}

std::string ClippedUtf8(const std::string& text, size_t bytes) {
  std::string out;
  base::TruncateUTF8ToByteSize(text, bytes, &out);
  return out;
}

bool PageModel::IsAncestor(int ancestor, int item) const {
  for (int at = item; at >= 0; at = items[at].parent) {
    if (at == ancestor) {
      return true;
    }
  }
  return false;
}

bool PageModel::OnSameChain(int a, int b) const {
  return IsAncestor(a, b) || IsAncestor(b, a);
}

int PageModel::Find(int frame, int dom) const {
  if (dom <= 0) {
    return -1;
  }
  auto it = by_dom.find({frame, dom});
  return it == by_dom.end() ? -1 : it->second;
}

int PageModel::FrameWithToken(const std::string& token) const {
  for (size_t i = 0; i < frames.size(); ++i) {
    if (!token.empty() && frames[i].token == token) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

int PageModel::ChildFrameOfHost(int host) const {
  for (size_t i = 1; i < frames.size(); ++i) {
    if (frames[i].host == host) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

bool PageModel::InViewport(int item) const {
  const AxItem& data = items[item];
  if (data.offscreen || data.box.IsEmpty()) {
    return false;
  }
  gfx::RectF visible = data.visible;
  visible.Intersect(gfx::RectF(viewport));
  return visible.width() >= 1 && visible.height() >= 1;
}

gfx::PointF PageModel::ClickPoint(int item) const {
  gfx::RectF visible = items[item].visible;
  visible.Intersect(gfx::RectF(viewport));
  if (visible.IsEmpty()) {
    visible = items[item].box;
  }
  return visible.CenterPoint();
}

std::optional<PageModel> BuildPageModel(ui::AXTreeUpdate& update,
                                        double scale,
                                        std::string* error) {
  if (update.nodes.empty()) {
    *error = "the page has no accessibility tree yet";
    return std::nullopt;
  }
  std::map<int, int> parent_of;
  bool combined = false;
  int roots = 0;
  for (const ui::AXNodeData& node : update.nodes) {
    for (int child : node.child_ids) {
      parent_of[child] = node.id;
    }
    if (node.HasIntAttribute(ax::mojom::IntAttribute::kDOMNodeIdDeprecated)) {
      combined = true;
    }
    if (node.role == Role::kRootWebArea) {
      ++roots;
    }
  }
  combined = combined || roots > 1;
  for (ui::AXNodeData& node : update.nodes) {
    if (node.role != Role::kRootWebArea || node.id == update.root_id) {
      continue;
    }
    auto parent = parent_of.find(node.id);
    if (parent != parent_of.end() &&
        node.relative_bounds.offset_container_id <= 0) {
      node.relative_bounds.offset_container_id = parent->second;
    }
  }
  ui::AXTree tree;
  if (!tree.Unserialize(update)) {
    *error = "the page's accessibility tree didn't parse";
    return std::nullopt;
  }
  const ui::AXNode* root = tree.root();
  if (!root) {
    *error = "the page has no accessibility tree yet";
    return std::nullopt;
  }
  PageModel model;
  model.scale = scale > 0 ? scale : 1.0;
  model.frames.push_back(AxFrame{});
  const int focus_id = tree.data().focus_id;
  struct Pending {
    const ui::AXNode* node;
    int parent;
    int depth;
    int frame;
  };
  std::vector<Pending> stack{{root, -1, 0, 0}};
  while (!stack.empty()) {
    Pending at = stack.back();
    stack.pop_back();
    const ui::AXNode* node = at.node;
    const ui::AXNodeData& data = node->data();
    const int index = static_cast<int>(model.items.size());
    AxItem item;
    item.parent = at.parent;
    item.depth = at.depth;
    item.frame = at.frame;
    if (data.role == Role::kRootWebArea && at.parent >= 0 &&
        model.frames.size() < kMaxFrames) {
      AxFrame frame;
      frame.root = index;
      frame.host = at.parent;
      frame.parent = model.items[at.parent].frame;
      item.frame = static_cast<int>(model.frames.size());
      model.frames.push_back(frame);
      model.items[at.parent].frame_host = true;
    }
    if (combined) {
      item.dom = data.GetIntAttribute(
          ax::mojom::IntAttribute::kDOMNodeIdDeprecated);
    } else {
      item.dom = data.GetDOMNodeId();
    }
    item.role = ui::ToString(data.role);
    item.name = ClippedUtf8(
        data.GetStringAttribute(ax::mojom::StringAttribute::kName),
        kMaxNameBytes);
    item.value = ClippedUtf8(
        data.GetStringAttribute(ax::mojom::StringAttribute::kValue),
        kMaxNameBytes);
    bool offscreen = false;
    gfx::RectF visible =
        tree.RelativeToTreeBounds(node, gfx::RectF(), &offscreen, true);
    gfx::RectF bounds =
        tree.RelativeToTreeBounds(node, gfx::RectF(), nullptr, false);
    visible.Scale(static_cast<float>(1.0 / model.scale));
    bounds.Scale(static_cast<float>(1.0 / model.scale));
    item.box = bounds;
    item.visible = visible;
    item.offscreen = offscreen;
    item.hidden = node->IsInvisibleOrIgnored();
    item.disabled = data.GetRestriction() == ax::mojom::Restriction::kDisabled;
    switch (data.GetCheckedState()) {
      case ax::mojom::CheckedState::kFalse:
        item.checked = 0;
        break;
      case ax::mojom::CheckedState::kTrue:
        item.checked = 1;
        break;
      case ax::mojom::CheckedState::kMixed:
        item.checked = 2;
        break;
      default:
        break;
    }
    if (data.HasState(ax::mojom::State::kExpanded)) {
      item.expanded = 1;
    } else if (data.HasState(ax::mojom::State::kCollapsed)) {
      item.expanded = 0;
    }
    item.focused = node->id() == focus_id;
    item.modal = (data.role == Role::kDialog ||
                  data.role == Role::kAlertDialog) &&
                 data.GetBoolAttribute(ax::mojom::BoolAttribute::kModal);
    const ax::mojom::DefaultActionVerb verb = data.GetDefaultActionVerb();
    item.interactive =
        IsInteractiveRole(data.role) ||
        (verb != ax::mojom::DefaultActionVerb::kNone &&
         verb != ax::mojom::DefaultActionVerb::kClickAncestor &&
         data.role != Role::kRootWebArea && data.role != Role::kStaticText &&
         data.role != Role::kInlineTextBox);
    item.structural = IsStructuralRole(data.role, !item.name.empty());
    item.text = data.role == Role::kStaticText && !item.name.empty();
    if (item.focused) {
      model.focus = index;
    }
    if (item.dom > 0) {
      model.by_dom.emplace(std::make_pair(item.frame, item.dom), index);
    }
    if (at.parent >= 0) {
      model.items[at.parent].children.push_back(index);
    }
    model.items.push_back(std::move(item));
    const auto& children = node->children();
    for (auto it = children.rbegin(); it != children.rend(); ++it) {
      stack.push_back({*it, index, at.depth + 1, model.items[index].frame});
    }
  }
  model.viewport = model.items[0].box.size();
  for (size_t i = 0; i < model.items.size(); ++i) {
    const AxItem& item = model.items[i];
    if (item.modal && !item.hidden && !item.visible.IsEmpty()) {
      model.modal = static_cast<int>(i);
    }
  }
  return model;
}

std::string Fingerprint(const AxItem& item) {
  const std::string key = base::StrCat({item.role, "\n", item.name});
  const uint32_t hash = base::PersistentHash(key);
  return base::StringPrintf("%08x", hash);
}

int BlockerOf(const PageModel& model, int hit, int target) {
  if (hit < 0 || target < 0 || model.OnSameChain(hit, target)) {
    return -1;
  }
  std::set<int> chain;
  for (int at = target; at >= 0; at = model.items[at].parent) {
    chain.insert(at);
  }
  int last = hit;
  for (int at = hit; at >= 0 && !chain.contains(at);
       at = model.items[at].parent) {
    last = at;
  }
  return last;
}

std::vector<DismissChoice> DismissChoices(const PageModel& model,
                                          int layer,
                                          size_t limit) {
  std::vector<DismissChoice> found;
  if (layer < 0) {
    return found;
  }
  std::vector<int> stack{layer};
  size_t visited = 0;
  while (!stack.empty() && visited < 4000) {
    const int at = stack.back();
    stack.pop_back();
    ++visited;
    const AxItem& item = model.items[at];
    for (auto it = item.children.rbegin(); it != item.children.rend(); ++it) {
      stack.push_back(*it);
    }
    if (!item.interactive || item.hidden || item.disabled ||
        item.box.IsEmpty()) {
      continue;
    }
    if (item.role != "button" && item.role != "link" &&
        item.role != "menuItem" && item.role != "toggleButton") {
      continue;
    }
    const std::string name = Lowered(item.name);
    if (name.empty()) {
      continue;
    }
    DismissChoice choice;
    choice.item = at;
    if (name == "x" || name == "\xC3\x97" || name == "\xE2\x9C\x95" ||
        name == "\xE2\x9C\x96" || name == "\xE2\x95\xB3" ||
        Contains(name, "close") || Contains(name, "dismiss") ||
        name == "no thanks" || name == "no, thanks" || name == "not now" ||
        name == "skip" || name == "maybe later" || name == "later" ||
        name == "cancel") {
      choice.kind = "close";
      choice.score = 30;
    } else if (Contains(name, "reject") || Contains(name, "decline") ||
               Contains(name, "deny") || Contains(name, "only necessary") ||
               Contains(name, "necessary only") ||
               Contains(name, "essential only") || Contains(name, "refuse") ||
               Contains(name, "disagree")) {
      choice.kind = "reject";
      choice.score = 20;
    } else if (Contains(name, "accept") || Contains(name, "agree") ||
               Contains(name, "allow") || name == "got it" || name == "ok" ||
               name == "okay" || Contains(name, "i understand") ||
               name == "continue" || Contains(name, "consent") ||
               name == "understood") {
      choice.kind = "accept";
      choice.score = 10;
    } else {
      continue;
    }
    if (item.role == "button") {
      choice.score += 2;
    }
    found.push_back(choice);
  }
  std::stable_sort(found.begin(), found.end(),
                   [](const DismissChoice& a, const DismissChoice& b) {
                     return a.score > b.score;
                   });
  if (found.size() > limit) {
    found.resize(limit);
  }
  return found;
}

base::ListValue BoxValue(const gfx::RectF& box) {
  return base::ListValue()
      .Append(std::round(box.x() * 10) / 10)
      .Append(std::round(box.y() * 10) / 10)
      .Append(std::round(box.width() * 10) / 10)
      .Append(std::round(box.height() * 10) / 10);
}

RefStore::RefStore(content::WebContents* contents)
    : content::WebContentsUserData<RefStore>(*contents),
      content::WebContentsObserver(contents) {}

RefStore::~RefStore() = default;

std::string RefStore::KeyFrame(const PageModel& model, int frame) const {
  const std::string& token = model.frames[frame].token;
  return token.empty() ? base::StrCat({"f", base::NumberToString(frame)})
                       : token;
}

std::string RefStore::RefFor(const PageModel& model, int index) {
  const AxItem& item = model.items[index];
  const std::string frame = KeyFrame(model, item.frame);
  ++clock_;
  if (item.dom > 0) {
    auto key = keys_.find({frame, item.dom});
    if (key != keys_.end()) {
      Entry& entry = entries_[key->second];
      entry.role = item.role;
      entry.name = item.name;
      entry.box = item.box;
      entry.used = clock_;
      return key->second;
    }
  }
  std::string ref = base::StrCat({"e", base::NumberToString(next_++)});
  entries_[ref] = Entry{frame, item.dom, item.role, item.name, item.box,
                        clock_};
  if (item.dom > 0) {
    keys_[{frame, item.dom}] = ref;
  }
  Trim();
  return ref;
}

RefStore::Resolved RefStore::Resolve(const std::string& ref,
                                     const PageModel& model) {
  Resolved out;
  auto found = entries_.find(ref);
  if (found == entries_.end()) {
    out.error = base::StrCat({"unknown ref ", ClippedUtf8(ref, 32),
                              "; take a new snapshot"});
    return out;
  }
  Entry& entry = found->second;
  entry.used = ++clock_;
  int frame = model.FrameWithToken(entry.frame);
  if (frame < 0 && entry.frame.size() > 1 && entry.frame[0] == 'f') {
    int index = 0;
    if (base::StringToInt(std::string_view(entry.frame).substr(1), &index) &&
        index >= 0 && static_cast<size_t>(index) < model.frames.size()) {
      frame = index;
    }
  }
  if (frame >= 0) {
    const int item = model.Find(frame, entry.dom);
    if (item >= 0 && !model.items[item].hidden &&
        model.items[item].role == entry.role) {
      out.item = item;
      out.changed = model.items[item].name != entry.name;
      entry.name = model.items[item].name;
      entry.box = model.items[item].box;
      return out;
    }
  }
  const gfx::PointF was = entry.box.CenterPoint();
  int best = -1;
  float best_distance = 0;
  for (size_t i = 0; i < model.items.size(); ++i) {
    const AxItem& item = model.items[i];
    if (item.hidden || item.role != entry.role || item.name != entry.name ||
        (item.name.empty() && !item.interactive)) {
      continue;
    }
    const float distance =
        (item.box.CenterPoint() - was).Length() +
        (KeyFrame(model, item.frame) == entry.frame ? 0.0f : 100000.0f);
    if (best < 0 || distance < best_distance) {
      best = static_cast<int>(i);
      best_distance = distance;
    }
  }
  if (best < 0) {
    out.error = base::StrCat(
        {"ref ", ref, " is stale: no ", entry.role, " named \"",
         ClippedUtf8(entry.name, 80), "\" is on the page now"});
    return out;
  }
  const AxItem& item = model.items[best];
  if (entry.dom > 0) {
    keys_.erase({entry.frame, entry.dom});
  }
  entry.frame = KeyFrame(model, item.frame);
  entry.dom = item.dom;
  entry.box = item.box;
  if (item.dom > 0) {
    auto old = keys_.find({entry.frame, item.dom});
    if (old != keys_.end() && old->second != ref) {
      entries_.erase(old->second);
    }
    keys_[{entry.frame, item.dom}] = ref;
  }
  out.item = best;
  out.rebound = true;
  return out;
}

void RefStore::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (!navigation->HasCommitted() || navigation->IsSameDocument()) {
    return;
  }
  if (navigation->IsInPrimaryMainFrame()) {
    ++generation_;
    keys_.clear();
    for (auto& [ref, entry] : entries_) {
      entry.dom = 0;
    }
    return;
  }
  content::RenderFrameHost* frame = navigation->GetRenderFrameHost();
  if (!frame) {
    return;
  }
  const std::string token = frame->GetDevToolsFrameToken().ToString();
  for (auto it = keys_.begin(); it != keys_.end();) {
    if (it->first.first == token) {
      auto entry = entries_.find(it->second);
      if (entry != entries_.end()) {
        entry->second.dom = 0;
      }
      it = keys_.erase(it);
    } else {
      ++it;
    }
  }
}

void RefStore::Trim() {
  if (entries_.size() <= kMaxRefEntries) {
    return;
  }
  std::vector<std::pair<uint64_t, std::string>> ages;
  for (const auto& [ref, entry] : entries_) {
    ages.emplace_back(entry.used, ref);
  }
  std::sort(ages.begin(), ages.end());
  for (size_t i = 0; i < kRefTrim && i < ages.size(); ++i) {
    auto it = entries_.find(ages[i].second);
    if (it == entries_.end()) {
      continue;
    }
    if (it->second.dom > 0) {
      keys_.erase({it->second.frame, it->second.dom});
    }
    entries_.erase(it);
  }
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(RefStore);

}
