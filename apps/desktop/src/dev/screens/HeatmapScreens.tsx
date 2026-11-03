// Review page for the heat map (P0.5-08), development builds only: #/screens/heatmap.
// A made-up year; ?size=small|medium|large.
import { useMemo, useState } from "react";
import { HeatMap } from "../../heatmap/HeatMap";
import { setAppearance, useAppearance } from "../../settings/appearance";
import { useColorMode } from "../../theme/mode.ts";
import { SCHEMES } from "../../theme/tokens.ts";
import { Glass } from "../../ui/glass/Glass";
import { GlassBackdrop } from "../../ui/glass/GlassBackdrop";
import { GlassProvider } from "../../ui/glass/GlassProvider";
import { useWallpaper } from "../../ui/glass/wallpaper";
import { Segmented } from "../../ui/Segmented";
import { showToast } from "../../ui/toast";
import { ToastRegion } from "../../ui/Toasts";
import { demoItems, demoYear } from "./heatDemo";
import "../lab.css";
import "./screens.css";

const params = new URLSearchParams(location.hash.split("?")[1]);
const SIZES = [
  { id: "small", label: "首页小组件" },
  { id: "medium", label: "8×3" },
  { id: "large", label: "铺满一格" },
];

function Page() {
  const mode = useColorMode();
  const appearance = useAppearance();
  const wallpaper = useWallpaper(mode, SCHEMES.aurora[0]);
  const [size, setSize] = useState(String(params.get("size") ?? "medium"));
  const data = useMemo(() => demoYear(), []);
  const itemsOf = useMemo(() => demoItems(data), [data]);
  return (
    <div className="lab">
      <GlassBackdrop source={wallpaper} accent={SCHEMES.aurora[0][0]} />
      <main className="screen-heat">
        <div className="screen-heat-bar">
          <Segmented
            aria-label="尺寸"
            options={SIZES}
            value={size}
            onChange={(k) => setSize(String(k))}
          />
          <Segmented
            aria-label="深浅"
            options={[
              { id: "light", label: "浅色" },
              { id: "dark", label: "深色" },
            ]}
            value={appearance.mode === "system" ? mode : appearance.mode}
            onChange={(k) => setAppearance({ mode: k as "light" | "dark" })}
          />
        </div>
        <Glass refract={false} className="screen-heat-panel" data-size={size}>
          <HeatMap
            data={data}
            itemsOf={itemsOf}
            onOpen={(item) => showToast({ text: `（开发版）打开 ${item.title}` })}
          />
        </Glass>
      </main>
      <ToastRegion />
    </div>
  );
}

export function HeatmapScreens() {
  return (
    <GlassProvider accent={SCHEMES.aurora[0][0]}>
      <Page />
    </GlassProvider>
  );
}
