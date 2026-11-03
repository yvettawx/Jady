// The home widgets drawn from data the caller passes in (P1 feeds them from the core):
// reminders and today's to-dos. They are registered as panels by whoever owns
// the data, so the same widget also works in a workspace cell.
import { Checkbox } from "react-aria-components";
import { useT } from "../i18n/context";
import { Icon } from "../ui/Icon";

export interface Reminder {
  id: string;
  title: string;
  /** Already formatted, e.g. 今天 15:00. */
  when: string;
}

export function Reminders({ items, onOpen }: { items: Reminder[]; onOpen: (id: string) => void }) {
  const t = useT();
  if (!items.length) return <p className="dem-widget-empty">{t("home.reminders.empty")}</p>;
  return (
    <ul className="dem-widget-list">
      {items.map((r) => (
        <li key={r.id}>
          <button type="button" className="dem-widget-row" onClick={() => onOpen(r.id)}>
            <span className="dem-widget-row-title">{r.title}</span>
            <span className="dem-widget-row-meta">{r.when}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

export function TodayTodos({
  items,
  onToggle,
}: {
  items: Todo[];
  onToggle: (id: string, done: boolean) => void;
}) {
  const t = useT();
  if (!items.length) return <p className="dem-widget-empty">{t("home.todos.empty")}</p>;
  return (
    <ul className="dem-widget-list">
      {items.map((x) => (
        <li key={x.id}>
          <Checkbox className="dem-todo" isSelected={x.done} onChange={(v) => onToggle(x.id, v)}>
            <span className="dem-todo-box" aria-hidden>
              <Icon name="check" size={12} />
            </span>
            <span className="dem-todo-title">{x.title}</span>
          </Checkbox>
        </li>
      ))}
    </ul>
  );
}
