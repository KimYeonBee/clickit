import type { FileKind } from "../src/gitService";

/**
 * 화면 문구 언어. 확장이 config 메시지로 알려주면 App이 setLang을 부르고 다시 그린다.
 * 문구는 t("한국어", "English") 로 나란히 적는다 — 한쪽만 고치고 다른 쪽을 잊지 않게.
 */
export type Lang = "ko" | "en";

let current: Lang = "ko";

export function setLang(lang: Lang) {
  current = lang;
  document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(ko: string, en: string): string {
  return current === "en" ? en : ko;
}

export function fileLabel(kind: FileKind): string {
  switch (kind) {
    case "modified":
      return t("수정됨", "Modified");
    case "added":
      return t("새 파일", "New");
    case "deleted":
      return t("삭제됨", "Deleted");
    case "renamed":
      return t("이름 바뀜", "Renamed");
    case "copied":
      return t("복사됨", "Copied");
    case "conflict":
      return t("충돌", "Conflict");
    default:
      return t("변경됨", "Changed");
  }
}

/** "3일 전" / "3 days ago" */
export function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const min = Math.floor((Date.now() - then) / 60000);
  const unit = (n: number, ko: string, en: string) => t(`${n}${ko} 전`, `${n} ${en}${n === 1 ? "" : "s"} ago`);
  if (min < 1) return t("방금", "just now");
  if (min < 60) return unit(min, "분", "min");
  const hour = Math.floor(min / 60);
  if (hour < 24) return unit(hour, "시간", "hour");
  const day = Math.floor(hour / 24);
  if (day < 30) return unit(day, "일", "day");
  const month = Math.floor(day / 30);
  if (month < 12) return unit(month, "달", "month");
  return unit(Math.floor(month / 12), "년", "year");
}
