// Finds the plugins: every src/plugins/<name>/index.ts(x) is built into the app. A folder starting
// with `_` is left out; those are examples to copy. A broken plugin only loses itself. External
// plugins, installed from a folder and run in a sandbox, start here too (external/host.tsx).
import type { Translate } from "../i18n/messages";
import { showToast } from "../ui/toast";
import type { WorkspaceApi } from "../workspace/api";
import { PLUGIN_API_VERSION, startPlugin, type Plugin } from "./api";
import { startExternalPlugins } from "./external/host";

const found = import.meta.glob<{ default: Plugin }>(
  ["./*/index.ts", "./*/index.tsx", "!./_*/index.ts", "!./_*/index.tsx"],
  { eager: true },
);

export function startPlugins(host: {
  t: Translate;
  locale: string;
  workspace: () => WorkspaceApi | null;
}): () => void {
  const stops: (() => void)[] = [startExternalPlugins(host)];
  for (const [path, module] of Object.entries(found)) {
    try {
      if ((module.default.apiVersion ?? 1) > PLUGIN_API_VERSION) {
        showToast({ text: host.t("plugin.tooNew", { name: path }), tone: "danger" });
        continue;
      }
      stops.push(startPlugin(module.default, host));
    } catch (e) {
      console.error(path, e);
      showToast({ text: host.t("plugin.failed", { name: path }), tone: "danger" });
    }
  }
  return () => stops.reverse().forEach((f) => f());
}
