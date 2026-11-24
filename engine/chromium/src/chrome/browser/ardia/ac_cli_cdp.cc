// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_cdp.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/task/sequenced_task_runner.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ardia {

std::string CdpErrorText(const base::DictValue& error) {
  const std::string* text = error.FindString("message");
  return text && !text->empty() ? *text : std::string("error");
}

std::unique_ptr<CdpSession> CdpSession::Attach(content::WebContents* contents,
                                               CdpAccess access,
                                               std::string* error) {
  if (!contents || contents->IsBeingDestroyed()) {
    *error = "the tab is gone";
    return nullptr;
  }
  auto session = base::WrapUnique(new CdpSession(access));
  session->host_ = content::DevToolsAgentHost::GetOrCreateFor(contents);
  if (!session->host_ || !session->host_->AttachClient(session.get())) {
    session->host_ = nullptr;
    *error = "can't inspect this tab";
    return nullptr;
  }
  return session;
}

CdpSession::CdpSession(CdpAccess access) : access_(access) {}

CdpSession::~CdpSession() {
  closed_.Reset();
  if (host_) {
    scoped_refptr<content::DevToolsAgentHost> host = std::move(host_);
    host->DetachClient(this);
  }
  FailAll("the DevTools session ended");
}

void CdpSession::Send(std::string_view method,
                      base::DictValue params,
                      CdpDone done,
                      std::string_view session_id,
                      std::optional<base::TimeDelta> timeout) {
  if (!host_) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(done),
                                  base::unexpected("the tab's DevTools target "
                                                   "closed")));
    return;
  }
  const int id = next_id_++;
  base::DictValue message;
  message.Set("id", id);
  message.Set("method", method);
  message.Set("params", std::move(params));
  if (!session_id.empty()) {
    message.Set("sessionId", session_id);
  }
  std::optional<std::string> json = base::WriteJson(message);
  if (!json) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(std::move(done), base::unexpected("params aren't JSON")));
    return;
  }
  pending_[id] = std::move(done);
  if (timeout) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&CdpSession::TimedOut, weak_factory_.GetWeakPtr(), id),
        *timeout);
  }
  scoped_refptr<content::DevToolsAgentHost> host = host_;
  host->DispatchProtocolMessage(this, base::as_byte_span(*json));
}

void CdpSession::DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                                         base::span<const uint8_t> message) {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(&CdpSession::Deliver, weak_factory_.GetWeakPtr(),
                     std::string(base::as_string_view(message))));
}

void CdpSession::Deliver(std::string message) {
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(message, base::JSON_PARSE_RFC);
  if (!parsed) {
    return;
  }
  if (std::optional<int> id = parsed->FindInt("id")) {
    auto it = pending_.find(*id);
    if (it == pending_.end()) {
      return;
    }
    CdpDone done = std::move(it->second);
    pending_.erase(it);
    if (const base::DictValue* error = parsed->FindDict("error")) {
      std::move(done).Run(base::unexpected(CdpErrorText(*error)));
      return;
    }
    base::DictValue* result = parsed->FindDict("result");
    std::move(done).Run(result ? std::move(*result) : base::DictValue());
    return;
  }
  const std::string* method = parsed->FindString("method");
  if (!method || !event_sink_) {
    return;
  }
  const std::string* session_id = parsed->FindString("sessionId");
  base::DictValue* params = parsed->FindDict("params");
  event_sink_.Run(*method, params ? std::move(*params) : base::DictValue(),
                  session_id ? *session_id : std::string(), message.size());
}

void CdpSession::AgentHostClosed(content::DevToolsAgentHost* agent_host) {
  host_ = nullptr;
  FailAll("the tab's DevTools target closed");
  if (closed_) {
    std::move(closed_).Run("target-closed");
  }
}

bool CdpSession::MayAttachToURL(const GURL& url, bool is_webui) {
  return access_.trusted || !is_webui;
}

bool CdpSession::IsTrusted() {
  return access_.trusted;
}

bool CdpSession::MayReadLocalFiles() {
  return access_.local_files;
}

bool CdpSession::MayWriteLocalFiles() {
  return access_.local_files;
}

void CdpSession::TimedOut(int id) {
  auto it = pending_.find(id);
  if (it == pending_.end()) {
    return;
  }
  CdpDone done = std::move(it->second);
  pending_.erase(it);
  std::move(done).Run(base::unexpected("timed out"));
}

void CdpSession::FailAll(const std::string& why) {
  std::map<int, CdpDone> pending = std::move(pending_);
  pending_.clear();
  for (auto& [id, done] : pending) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(done), base::unexpected(why)));
  }
}

}
