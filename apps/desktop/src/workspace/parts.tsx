// The pieces dockview draws for us: each registered panel and each tab.
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from "dockview-react";
import type { FunctionComponent } from "react";
import { ContentTab } from "../ui/ContentTab";
import { useWorkspace } from "./context";
import type { TabParams } from "./convert";
import { panelDefinition, panelDefinitions } from "./registry";

// One object for the life of the page: dockview looks a panel up in it when it makes one, so panels
// registered later (an external plugin's, which load after the workspace) are found once added.
const live: Record<string, FunctionComponent<IDockviewPanelProps>> = {};

/** One stable dockview component per registered panel, including any registered since last time. */
// eslint-disable-next-line react-refresh/only-export-components -- builds components, is not one
export function dockviewComponents(): Record<string, FunctionComponent<IDockviewPanelProps>> {
  for (const def of panelDefinitions()) {
    if (live[def.id]) continue;
    const id = def.id;
    live[id] = function RegisteredPanel(props: IDockviewPanelProps) {
      const workspace = useWorkspace();
      const Render = panelDefinition(id)?.render;
      const params = (props.params ?? {}) as Partial<TabParams>;
      if (!Render || !workspace) return null;
      return (
        <Render
          tabId={props.api.id}
          contentId={params.contentId ?? props.api.id}
          kind={params.kind ?? "temp"}
          params={params.extra ?? {}}
          workspace={workspace}
        />
      );
    };
  }
  return live;
}

const lockOf = (p: unknown) =>
  p === "sensitive" || p === "private" || p === "secret" ? p : undefined;

const sessionOf = (s: unknown) =>
  s === "authorized" ? ("auth" as const) : s === "webAuthorized" ? ("webAuth" as const) : undefined;

export function WorkspaceTab(props: IDockviewPanelHeaderProps) {
  const workspace = useWorkspace();
  const params = (props.params ?? {}) as Partial<TabParams>;
  const icon = panelDefinition(String(props.api.component))?.icon;
  return (
    <span
      className="dem-ws-tab"
      data-tab-id={props.api.id}
      onDoubleClick={() => workspace?.promote(props.api.id)}
    >
      <ContentTab
        title={props.api.title ?? ""}
        kind={params.kind ?? "temp"}
        icon={icon}
        locked={lockOf(params.extra?.privacy)}
        session={sessionOf(params.extra?.session)}
        // No isActive here: dockview does not re-render tabs when the active one changes, so
        // a value read now goes stale. The .dv-active-tab class (always current) styles it.
        onClose={() => props.api.close()}
      />
    </span>
  );
}
