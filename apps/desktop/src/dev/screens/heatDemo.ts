// Made-up activity for the heat map's review page: a year that ends today, with quiet weekends,
// an exam push in June, a two-week gap in August, the job hunt in autumn, and a current streak.
import { dateKey, type HeatData, type HeatDay, type HeatItem } from "../../heatmap/model";

const TYPES = ["note", "diary", "todo", "card", "question", "file", "entity", "chat"];
const TITLES: Record<string, string[]> = {
  note: ["第 12 课 Le passé composé", "第三章草稿", "开发日志", "读书笔记"],
  diary: ["今天的日记"],
  todo: ["复习 6 个法语词", "投递 2 家实习"],
  card: ["le quai 站台", "être 和 avoir"],
  question: ["数据库第 3 章习题"],
  file: ["课堂录音"],
  entity: ["实习 A 的联系人"],
  chat: ["法语练习对话"],
};

function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function demoYear(today = new Date()): HeatData {
  const r = seeded(7);
  const days: HeatDay[] = [];
  const count = 371;
  for (let back = count - 1; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const month = d.getMonth();
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const gap = month === 7 && d.getDate() >= 5 && d.getDate() <= 18;
    const exam = month === 5;
    const hunt = month >= 8 && month <= 10;
    const streak = back < 12;
    const counts: Record<string, number> = {};
    const skip = !streak && r() < (weekend ? 0.42 : 0.12);
    if (!gap && !skip) {
      const base = (weekend ? 2 : 5) * (exam ? 2.6 : 1) * (0.5 + r() * 1.3);
      const add = (type: string, weight: number) => {
        const n = Math.round(base * weight * (0.4 + r()));
        if (n > 0) counts[type] = n;
      };
      add("note", 1);
      add("diary", 0.16);
      add("todo", 0.4);
      add("card", exam ? 1.3 : 0.7);
      add("question", exam ? 1 : 0.2);
      add("file", 0.08);
      add("entity", hunt ? 0.7 : 0.06);
      add("chat", 0.3 + (hunt ? 0.2 : 0));
    }
    days.push({ date: dateKey(d), counts });
  }
  return { days, types: TYPES };
}

/** What changed on a day, 机密 included: the card must leave those out itself. */
export function demoItems(data: HeatData) {
  return (date: string): HeatItem[] => {
    const day = data.days.find((d) => d.date === date);
    if (!day) return [];
    const items: HeatItem[] = Object.keys(day.counts).map((type, i) => {
      const list = TITLES[type] ?? [type];
      return {
        id: `${date}-${type}`,
        title: list[i % list.length] ?? type,
        type,
        privacy: type === "diary" ? "private" : type === "entity" ? "sensitive" : "normal",
      };
    });
    items.push({ id: `${date}-secret`, title: "证件和保单号", type: "note", privacy: "secret" });
    return items;
  };
}
