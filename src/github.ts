import * as vscode from "vscode";
import type { GitAuth } from "./gitService";
import { t } from "./lang";

/**
 * VS Code 내장 git이 GitHub에 쓰는 것과 같은 권한 묶음.
 * 같은 묶음이어야 이미 VS Code에서 GitHub 로그인을 해둔 사람은 다시 묻지 않고 그대로 쓸 수 있다.
 */
const SCOPES = ["repo", "workflow", "user:email", "read:user"];

/** interactive=false 면 로그인해 둔 게 있을 때만 돌려주고 창은 절대 안 띄운다 */
export async function getGitHubAuth(interactive: boolean, chooseAccount = false): Promise<GitAuth | undefined> {
  try {
    const session = await vscode.authentication.getSession(
      "github",
      SCOPES,
      // chooseAccount: 전에 고른 계정을 잊고 다시 고르게 한다 (다른 계정으로 바꾸기)
      chooseAccount ? { createIfNone: true, clearSessionPreference: true } : interactive ? { createIfNone: true } : { silent: true }
    );
    return session ? { user: session.account.label, token: session.accessToken } : undefined;
  } catch {
    return undefined; // 로그인 창을 닫거나 허용을 안 누른 경우
  }
}

export const isGitHubUrl = (url: string | null | undefined): boolean =>
  !!url && /^https:\/\/(www\.)?github\.com\//i.test(url);

/**
 * 로그인을 안 해서 막힌 것으로 보이는지.
 * GitHub은 로그인 안 한 사람에게 비공개 저장소를 "없는 저장소"라고 답하므로 not found도 포함한다.
 */
function looksLikeMissingLogin(raw: string): boolean {
  return /could not read username|terminal prompts disabled|authentication failed|invalid username or password|repository .* not found/i.test(
    raw
  );
}

/** 왜 필요한지 먼저 말하고, 동의하면 로그인 창을 띄운다 */
export async function askGitHubLogin(reason: string): Promise<GitAuth | undefined> {
  const LOGIN = t("GitHub 로그인", "Sign in to GitHub");
  const pick = await vscode.window.showInformationMessage(
    t("GitHub 로그인이 필요해요.", "You need to sign in to GitHub."),
    {
      modal: true,
      detail: t(
        `${reason}\n\n브라우저가 열리면 GitHub 화면에서 [Authorize]를 눌러 주세요. 한 번만 하면 다음부터는 묻지 않아요.`,
        `${reason}\n\nWhen your browser opens, click [Authorize] on GitHub. You only need to do this once.`
      ),
    },
    LOGIN
  );
  if (pick !== LOGIN) return undefined;
  return getGitHubAuth(true);
}

/**
 * GitHub에 닿는 git 작업을 실행한다.
 * 로그인해 둔 게 있으면 그걸 쓰고, 없어서 막히면 그때 로그인을 받아 한 번 더 시도한다.
 * 공개 저장소 가져오기처럼 로그인이 필요 없는 일은 로그인 없이 그냥 된다.
 */
export async function withGitHubLogin<T>(
  url: string | null | undefined,
  reason: string,
  op: (auth?: GitAuth) => Promise<T>
): Promise<T> {
  const saved = isGitHubUrl(url) ? await getGitHubAuth(false) : undefined;
  try {
    return await op(saved);
  } catch (e: any) {
    if (saved || !isGitHubUrl(url) || !looksLikeMissingLogin(e?.message ?? "")) throw e;
    const auth = await askGitHubLogin(reason);
    if (!auth) throw e;
    return op(auth);
  }
}

/** 화면에 그대로 보여줄 쉬운 말과, 접어서 볼 원문을 같이 들고 다니는 에러 */
export class FriendlyError extends Error {
  constructor(message: string, public readonly raw: string, public readonly nameTaken = false) {
    super(message);
  }
}

export async function createGitHubRepo(
  auth: GitAuth,
  name: string,
  isPrivate: boolean
): Promise<{ cloneUrl: string; htmlUrl: string }> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "EasyGit",
      },
      body: JSON.stringify({ name, private: isPrivate }),
    });
  } catch (e: any) {
    throw new FriendlyError(t("인터넷 연결을 확인해 주세요.", "Check your internet connection."), e?.message ?? String(e));
  }

  const body: any = await res.json().catch(() => ({}));
  const raw = `${res.status} ${JSON.stringify(body)}`;
  if (res.ok) return { cloneUrl: body.clone_url, htmlUrl: body.html_url };
  if (res.status === 422 && /already exists/i.test(raw)) {
    throw new FriendlyError(t("GitHub에 이미 같은 이름의 저장소가 있어요. 다른 이름을 적어 주세요.", "You already have a GitHub repository with that name. Try another name."), raw, true);
  }
  if (res.status === 401) throw new FriendlyError(t("GitHub 로그인이 만료됐어요. 다시 로그인해 주세요.", "Your GitHub sign-in expired. Please sign in again."), raw);
  throw new FriendlyError(t(`GitHub에 저장소를 만들지 못했어요. (오류 ${res.status})`, `Couldn't create the repository on GitHub. (error ${res.status})`), raw);
}

/** 폴더 이름 → GitHub 저장소 이름으로 쓸 수 있게 다듬기. "내 프로젝트 1" 처럼 한글·빈칸이면 기본값 */
export function suggestRepoName(folder: string): string {
  const cleaned = folder
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "my-project";
}

export function checkRepoName(raw: string): string | undefined {
  const name = raw.trim();
  if (!name) return t("이름을 적어 주세요.", "Enter a name.");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return t("영문, 숫자, - _ . 만 쓸 수 있어요. (한글·빈칸은 안 돼요)", "Use only letters, numbers, - _ . (no spaces)");
  if (name === "." || name === "..") return t("이 이름은 쓸 수 없어요.", "That name isn't allowed.");
  if (name.length > 100) return t("100자보다 짧게 적어 주세요.", "Keep it under 100 characters.");
  return undefined;
}
