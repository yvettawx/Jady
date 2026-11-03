// A link to another item in the text (docs/05-design.md §3.1, §3.3). Click: a small peek window
// where the item can be read and edited; ⌘-click (Ctrl on Windows): a new tab; ⇧-click: beside
// in a split. In the peek, ⌘↵ opens it as a tab and ⇧↵ in a split; Esc or a click outside closes.
// A link to an item that does not exist yet offers to create it.
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Dialog, Popover } from "react-aria-components";
import { useT } from "../i18n/context";
import type { PrivacyLevel } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { IS_MAC } from "../ui/shortcut";
import "./peek.css";

export interface LinkTarget {
  title: string;
  /** Plain text of the item, for the peek. */
  body: string;
  privacy?: PrivacyLevel;
}

export type OpenHow = "tab" | "split";

export function WikiLink({
  target,
  resolve,
  onOpen,
  onCreate,
  peekEditable = true,
}: {
  target: string;
  resolve: (target: string) => LinkTarget | null;
  onOpen: (target: string, how: OpenHow) => void;
  onCreate: (title: string) => void;
  /** Off when the peek only has a plain preview of the item to show. */
  peekEditable?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const item = resolve(target);
  const mod = (e: { metaKey: boolean; ctrlKey: boolean }) => (IS_MAC ? e.metaKey : e.ctrlKey);

  const secret = item?.privacy === "secret";
  const activate = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    // A 机密 item shows neither its title nor a peek: it opens to its verification.
    if (secret) return onOpen(target, "tab");
    if (item && mod(e)) onOpen(target, "tab");
    else if (item && e.shiftKey) onOpen(target, "split");
    else setOpen(true);
  };

  return (
    <>
      <a
        ref={ref}
        href={`#item:${encodeURIComponent(target)}`}
        className="dem-wikilink"
        data-missing={item ? undefined : ""}
        onClick={activate}
        onKeyDown={(e) => e.key === "Enter" && activate(e)}
      >
        {item?.privacy && item.privacy !== "normal" && <Icon name="lock" size={12} />}
        {secret ? t("privacy.secretTitle") : (item?.title ?? target)}
      </a>
      <Popover
        triggerRef={ref}
        isOpen={open}
        onOpenChange={setOpen}
        placement="bottom start"
        offset={6}
        className="dem-popover dem-peek"
      >
        <Dialog className="dem-peek-dialog" aria-label={item?.title ?? target}>
          <div
            className="dem-peek-inner"
            onKeyDown={(e) => {
              if (!item || e.key !== "Enter") return;
              if (mod(e) || e.shiftKey) {
                e.preventDefault();
                setOpen(false);
                onOpen(target, mod(e) ? "tab" : "split");
              }
            }}
          >
            {item ? (
              <>
                <h3 className="dem-peek-title">{item.title}</h3>
                <div
                  className="dem-peek-body dem-prose"
                  contentEditable={peekEditable}
                  suppressContentEditableWarning
                  aria-label={item.title}
                >
                  {item.body.split("\n").map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                <div className="dem-peek-actions">
                  <Button
                    size="sm"
                    variant="quiet"
                    onPress={() => (setOpen(false), onOpen(target, "split"))}
                  >
                    {t("peek.split")}
                  </Button>
                  <Button size="sm" onPress={() => (setOpen(false), onOpen(target, "tab"))}>
                    {t("peek.openTab")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h3 className="dem-peek-title">{target}</h3>
                <p className="dem-peek-missing">{t("peek.missing")}</p>
                <div className="dem-peek-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    icon="plus"
                    onPress={() => (setOpen(false), onCreate(target))}
                  >
                    {t("peek.create", { title: target })}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Dialog>
      </Popover>
    </>
  );
}
