// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_SCREENSHOT_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_SCREENSHOT_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "ui/gfx/geometry/rect_f.h"

namespace content {
class WebContents;
}

namespace ardia {

struct ScreenshotOptions {
  bool png = false;
  int quality = 80;
  std::optional<gfx::RectF> clip;
  double scale = 1.0;
};

using ScreenshotDone =
    base::OnceCallback<void(base::expected<base::DictValue, std::string>)>;

void CaptureTabScreenshot(content::WebContents* contents,
                          ScreenshotOptions options,
                          ScreenshotDone done);

bool TabDrawsOnScreen(content::WebContents* contents);

std::optional<ScreenshotOptions> ScreenshotOptionsFromCdp(
    const base::DictValue& params);

std::optional<ScreenshotOptions> ScreenshotOptionsFromArgs(
    const base::DictValue& args,
    std::string* error);

}

#endif
