import { memo } from "react";
import { Pressable, View } from "react-native";
import { Symbol, Text, useHover, useTheme } from "../ui";
import { ADD_CHIP } from "./tokens";

export const AddChip = memo(function AddChip({ onPress }: { onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        {({ pressed }) => (
          <View
            style={{
              height: ADD_CHIP.height,
              borderRadius: ADD_CHIP.radius,
              backgroundColor: pressed ? theme.toolbarPressed : hovered ? theme.rowHover : undefined,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: ADD_CHIP.left,
              paddingRight: ADD_CHIP.right,
              gap: ADD_CHIP.gap,
            }}
          >
            <Symbol name="arrow.up.right" size={ADD_CHIP.glyph} weight="medium" color={theme.chipText} style={{ width: ADD_CHIP.glyphBox, height: ADD_CHIP.glyphBox }} />
            <Text tone="chipText" ardiaCentersCapitals>Open a tab or file</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
});
