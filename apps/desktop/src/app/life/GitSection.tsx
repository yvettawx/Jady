// 设置 › Git: which folders count (F6). This computer's own list; it does not sync.
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../../i18n/context";
import { Button } from "../../ui/Button";
import { failed } from "../actions";
import { api, itemsChanged } from "../api";
import { useLive } from "../live";
import { askInWindow } from "../panels/AiPanels";

const KEY = "git-repos";
const DAYS = 14;

export function GitSection() {
  const t = useT();
  const { data: repos } = useLive<string[]>(
    async () => JSON.parse((await api.localGet(KEY)) ?? "[]") as string[],
    [],
  );
  const save = (next: string[]) =>
    void api
      .localSet(KEY, JSON.stringify(next))
      .then(() => itemsChanged())
      .catch(failed(t, t("git.title")));
  const add = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string" && !repos.includes(dir)) save([...repos, dir]);
  };
  const summarize = async () => {
    const digest = await api.gitDigest(DAYS);
    await askInWindow(
      { session: "plain", mode: "chat", title: t("git.summary") },
      t("git.prompt", { days: DAYS, digest: digest || t("git.empty") }),
    );
  };
  return (
    <div className="dem-git">
      <p>{t("git.about")}</p>
      <ul className="dem-life-list">
        {repos.map((r) => (
          <li key={r} className="dem-life-type">
            <span className="dem-nav-title">{r}</span>
            <Button
              size="sm"
              variant="quiet"
              onPress={() => save(repos.filter((x) => x !== r))}
              aria-label={t("git.remove", { path: r })}
              icon="close"
            />
          </li>
        ))}
      </ul>
      <span className="dem-nav-actions">
        <Button size="sm" onPress={() => void add().catch(failed(t, t("git.title")))}>
          {t("git.add")}
        </Button>
        {repos.length > 0 && (
          <Button
            size="sm"
            icon="ai"
            onPress={() => void summarize().catch(failed(t, t("git.title")))}
          >
            {t("git.summary")}
          </Button>
        )}
      </span>
    </div>
  );
}
