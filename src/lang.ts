/**
 * 화면·확인창·에러에 쓰는 문구 언어. vscode를 가져오지 않는 작은 모듈이라 어디서든 쓸 수 있다.
 * 실제 값은 extension.ts가 설정(clickit.language)과 VS Code 표시 언어를 보고 정해 넣는다.
 */
export type Lang = "ko" | "en";

let current: Lang = "ko";

export function setLang(lang: Lang) {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** 한국어 문구와 영어 문구를 나란히 적고, 지금 언어에 맞는 쪽을 돌려준다 */
export function t(ko: string, en: string): string {
  return current === "en" ? en : ko;
}
