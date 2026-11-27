import type { Suggestion } from "@ardia/core";
import { memo } from "react";
import { Image, Pressable, Text as NativeText, View } from "react-native";
import { Button, Symbol, Text, useHover, useTheme, withAlpha, type Theme } from "../ui";
import { Favicon } from "../favicon/Favicon";
import { suggestionLabels } from "./suggestionLabels";
import { SELECTED_SUGGESTION_ALPHA, SUGGESTION } from "./tokens";

export { suggestionLabels };

const ICON_BOX = { width: SUGGESTION.iconBox, height: SUGGESTION.iconBox } as const;

const selectedFill = (theme: Theme) =>
  theme.powerUpColor ? withAlpha(theme.powerUpColor, theme.dark ? SELECTED_SUGGESTION_ALPHA.dark : SELECTED_SUGGESTION_ALPHA.light) : theme.commandBarSelected;

export function SuggestionIcon({ suggestion: s, color }: { suggestion: Suggestion; color?: string }) {
  const theme = useTheme();
  const tint = color ?? theme.textSecondary;
  switch (s.kind) {
    case "page":
      return <Favicon url={s.url} favicon={s.favicon} />;
    case "create":
      return <Favicon url={`https://${s.site}`} />;
    case "search":
      return <Symbol name="magnifyingglass" size={SUGGESTION.icon} color={tint} style={ICON_BOX} />;
    case "calc":
      return <Symbol name="equal.circle" size={SUGGESTION.calcIcon} color={tint} style={ICON_BOX} />;
    case "action":
      return <Symbol name={s.icon ?? "command"} size={SUGGESTION.icon} color={tint} style={ICON_BOX} />;
    case "extension":
      return s.icon ? (
        <Image source={{ uri: s.icon }} style={ICON_BOX} />
      ) : (
        <Symbol name="puzzlepiece.extension" size={SUGGESTION.icon} color={tint} style={ICON_BOX} />
      );
    case "provider":
      return <Favicon url={s.url} favicon={s.icon} />;
  }
}

export type RowActions = {
  choose(s: Suggestion): void;
  remove(url: string): void;
};

export const SuggestionList = memo(function SuggestionList({
  items,
  selectedIndex,
  trailing,
  dropdown,
  switchTabIcon,
  compactPageTitles,
  rowHeight,
  actions,
}: {
  items: Suggestion[];
  selectedIndex: number;
  trailing: string | null;
  dropdown: boolean;
  switchTabIcon: boolean;
  compactPageTitles: boolean;
  rowHeight: number;
  actions: RowActions;
}) {
  if (!items.length) return null;
  return (
    <View style={{ paddingHorizontal: dropdown ? SUGGESTION.dropdownListX : SUGGESTION.listX, paddingBottom: dropdown ? SUGGESTION.dropdownListBelow : SUGGESTION.listBelow }}>
      {items.map((s, i) => (
        <SuggestionRow
          key={i}
          suggestion={s}
          selected={i === selectedIndex}
          trailing={i === 0 ? trailing : null}
          height={rowHeight}
          dropdown={dropdown}
          switchTabIcon={switchTabIcon}
          compactPageTitles={compactPageTitles}
          actions={actions}
        />
      ))}
    </View>
  );
});

function sameSuggestion(a: Suggestion, b: Suggestion): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof Suggestion)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export const isRemovable = (s: Suggestion | undefined): s is Extract<Suggestion, { kind: "page" }> => s?.kind === "page" && !!s.visited && !s.tabId;

const SuggestionRow = memo(
  function SuggestionRow({
    suggestion: s,
    selected,
    trailing,
    height,
    dropdown,
    switchTabIcon,
    compactPageTitles,
    actions,
  }: {
    suggestion: Suggestion;
    selected: boolean;
    trailing: string | null;
    height: number;
    dropdown: boolean;
    switchTabIcon: boolean;
    compactPageTitles: boolean;
    actions: RowActions;
  }) {
    const theme = useTheme();
    const { hovered, hoverProps } = useHover();
    const [title, accessory] = suggestionLabels(s, dropdown);
    const showSwitchTabIcon = switchTabIcon && s.kind === "page" && !!s.tabId;
    const titleSize = compactPageTitles && (s.kind === "page" || s.kind === "provider") ? "body" : "title";
    const hint = trailing ?? (s.kind === "action" ? s.hint : s.kind === "provider" ? s.provider : null);
    const onRemove = isRemovable(s) ? () => actions.remove(s.url) : undefined;
    const removable = !!onRemove && (hovered || selected);
    return (
      <View {...hoverProps}>
        <Pressable onPress={() => actions.choose(s)} accessibilityRole={showSwitchTabIcon ? "button" : undefined} accessibilityLabel={showSwitchTabIcon ? `${title}, ${accessory}` : undefined}>
          <View
            style={{
              height,
              marginVertical: SUGGESTION.gapY,
              borderRadius: SUGGESTION.radius,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: SUGGESTION.padX,
              gap: SUGGESTION.gap,
              backgroundColor: selected ? selectedFill(theme) : hovered ? theme.commandBarHover : undefined,
            }}
          >
            <SuggestionIcon suggestion={s} />
            <Text lines={1} size={titleSize} ardiaCentersCapitals style={{ flexShrink: 1 }}>
              {title}
              {accessory && !showSwitchTabIcon ? (
                <NativeText style={{ color: theme.textSecondary }}>
                  {" — "}
                  {accessory}
                </NativeText>
              ) : null}
            </Text>
            <View style={{ flex: 1 }} />
            {hint && !removable ? <Text size="small" tone="textTertiary" ardiaCentersCapitals>{hint}</Text> : null}
            {showSwitchTabIcon ? <Symbol name="arrow.up.right" size={SUGGESTION.icon} color={theme.textSecondary} style={ICON_BOX} /> : null}
            {removable ? (
              <Button variant="icon" icon="xmark" size="s" color={theme.textSecondary} tooltip="Remove from History" onPress={onRemove} />
            ) : null}
          </View>
        </Pressable>
      </View>
    );
  },
  (a, b) => a.selected === b.selected && a.trailing === b.trailing && a.height === b.height && a.dropdown === b.dropdown && a.switchTabIcon === b.switchTabIcon && a.compactPageTitles === b.compactPageTitles && a.actions === b.actions && sameSuggestion(a.suggestion, b.suggestion),
);
