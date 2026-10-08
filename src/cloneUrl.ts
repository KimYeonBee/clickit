import { t } from "./lang";

/**
 * 초보자는 주소창에 보이는 GitHub 페이지 주소(…/tree/main 같은 것)를 그대로 붙여 넣기 쉽다.
 * git이 알아듣는 저장소 주소로 다듬는다.
 */
export function normalizeCloneUrl(raw: string): string {
  const url = raw.trim();
  const github = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (github) {
    const repo = github[2].replace(/\.git$/i, "");
    return `https://github.com/${github[1]}/${repo}.git`;
  }
  return url;
}

/** 입력칸에 바로 보여줄 쉬운 말. 문제 없으면 undefined */
export function checkCloneUrl(raw: string): string | undefined {
  const url = raw.trim();
  if (!url) return t("주소를 붙여 넣어 주세요.", "Paste a repository URL.");
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(url)) {
    return t(
      "https:// 로 시작하는 주소를 붙여 넣어 주세요. (예: https://github.com/아이디/저장소이름)",
      "Paste a URL starting with https:// (e.g. https://github.com/user/repo)"
    );
  }
  if (/^https?:\/\/(www\.)?github\.com\/?[^/]*\/?$/i.test(url)) {
    return t(
      "저장소 주소까지 필요해요. 아이디 뒤에 저장소 이름이 붙어 있어야 해요.",
      "That's a user page. Add the repository name after the username."
    );
  }
  if (!repoNameFromUrl(normalizeCloneUrl(url))) return t("주소에서 저장소 이름을 찾지 못했어요.", "Couldn't find a repository name in that URL.");
  return undefined;
}

/** https://github.com/me/my-app.git → my-app */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/\.git$/i, "");
  return /^[\w.-]+$/.test(name) && name !== "." && name !== ".." ? name : "";
}

/**
 * origin 주소 → 브라우저로 열 저장소 페이지 주소. 못 바꾸면 null
 * https://github.com/me/app.git, git@github.com:me/app.git, ssh://git@github.com/me/app.git → https://github.com/me/app
 */
export function webUrlFromRemote(raw: string): string | null {
  const url = raw.trim().replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  const scp = url.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/); // git@host:me/app
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(url);
    if (!/^(https?|ssh|git):$/.test(u.protocol) || !u.hostname) return null;
    // 주소에 로그인 정보(아이디:토큰@)가 들어 있어도 브라우저 주소에는 넣지 않는다. ssh 포트도 웹과 상관없다
    return `https://${u.hostname}${u.pathname}`;
  } catch {
    return null;
  }
}
