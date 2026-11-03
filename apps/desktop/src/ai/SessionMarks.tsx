// Which kind of session a chat is, always on show: what AI can read and whether it has the web
// depend on it (docs/05-design.md §5.6). An ordinary chat shows nothing.
import { useT } from "../i18n/context";
import { sessionHasWeb, type AiSession } from "../privacy/policy";
import { Icon } from "../ui/Icon";

export function SessionMarks({ session }: { session: AiSession }) {
  const t = useT();
  if (session === "plain") return null;
  return (
    <span className="dem-chat-session" data-session={session} data-testid="chat-session">
      <Icon name={sessionHasWeb(session) ? "web" : "privacy"} size={12} />
      {t(`privacy.session.${session}`)}
    </span>
  );
}
