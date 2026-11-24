import { pageFrameOf, type PageFrame } from "../../lib/windowLayout";
import { drawnWindowCornerRadius, usePageFrameInset, useRoundsZeroSidebarFrame, windowCornerRadius } from "../../state/windows/layout";
import { perLook } from "../ui/tokens";
import { sidebarCardGap } from "./dockMotion";
import { currentInterfaceScale, useCurrentInterfaceScale } from "../../state/settings/interfaceScale";

export type CardFrame = PageFrame & { dockGap: number };

const framesOfLook = perLook(() => new Map<string, CardFrame>());

export function cardFrameOf(inset: number, scale = currentInterfaceScale(), roundZeroFrame = false): CardFrame {
  const frames = framesOfLook();
  const key = `${inset}@${scale}:${roundZeroFrame}`;
  let frame = frames.get(key);
  if (!frame) frames.set(key, (frame = { ...pageFrameOf(inset, windowCornerRadius(), drawnWindowCornerRadius(), roundZeroFrame), dockGap: sidebarCardGap(inset) }));
  return frame;
}

export function useCardFrame(): CardFrame {
  const scale = useCurrentInterfaceScale();
  return cardFrameOf(usePageFrameInset(), scale, useRoundsZeroSidebarFrame());
}
