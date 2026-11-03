// The top of the home page (docs/05-design.md §8, P0.5 visual final): a small caption with the
// space, a large clock and the welcome line (PRD B1, from a template). Over the scene, no card.
import { useEffect, useState, type ReactNode } from "react";
import { useLocale, useT } from "../i18n/context";
import { greetingKey } from "./greeting";

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick on the second boundary so the seconds change together with the system clock.
    let t = 0;
    const tick = () => {
      setNow(new Date());
      t = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    t = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(t);
  }, []);
  return now;
}

export function HomeHero({ space, actions }: { space: string; actions?: ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const now = useNow();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(now);
  return (
    <header className="dem-home-head">
      <div className="dem-home-hero">
        <span className="dem-home-cap">{t("home.caption", { space })}</span>
        <p className="dem-home-clock">
          {time}
          <small>{String(now.getSeconds()).padStart(2, "0")}</small>
        </p>
        <p className="dem-home-greet">
          <span>{t(greetingKey(now.getHours()))}</span>
          <span>{date}</span>
        </p>
      </div>
      {actions && <div className="dem-home-actions">{actions}</div>}
    </header>
  );
}
