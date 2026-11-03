// In what AI shows, a link to something it cannot read: a lock and 受保护的内容, with no title
// and nothing to click, because the AI side never knew which item it was (policy.aiLink).
import { useT } from "../i18n/context";
import { Icon } from "../ui/Icon";
import "./privacy.css";

export function ProtectedLink() {
  const t = useT();
  return (
    <span className="dem-protected-link">
      <Icon name="lock" size={12} />
      {t("privacy.protected")}
    </span>
  );
}
