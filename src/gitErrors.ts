import { t } from "./lang";

export function isMissingIdentity(raw: string): boolean {
  const s = raw.toLowerCase();
  return s.includes("please tell me who you are") || s.includes("unable to auto-detect email address");
}

/** git이 내놓는 영어 에러 메시지를 초보자가 알아들을 설명으로 바꾼다. */
export function translateGitError(raw: string): string {
  const s = raw.toLowerCase();

  if (isMissingIdentity(raw)) {
    return t(
      "커밋에 남길 이름과 이메일이 필요해요. 커밋을 다시 누르면 입력할 수 있어요.",
      "Git needs your name and email for commits. Press Commit again to enter them."
    );
  }
  if (s.includes("nothing to commit")) {
    return t("커밋할 변경사항이 없어요.", "There's nothing to commit.");
  }
  if (s.includes("rejected") && (s.includes("fetch first") || s.includes("non-fast-forward") || s.includes("behind"))) {
    return t("GitHub에 새 커밋이 있어서 먼저 풀을 해야 해요.", "GitHub has new commits. Pull first, then push.");
  }
  // 되돌리기 실패도 "conflict"라는 말을 쓰므로 일반 충돌보다 먼저 본다
  if (s.includes("would be overwritten by revert") || (s.includes("revert") && s.includes("your local changes"))) {
    return t(
      "지금 고치던 파일과 되돌릴 내용이 겹쳐요. 먼저 바뀐 파일을 커밋하거나 잠시 치워 주세요.",
      "Your uncommitted changes overlap with what you're reverting. Commit or stash them first."
    );
  }
  if (s.includes("could not revert") || (s.includes("revert") && s.includes("conflict"))) {
    return t(
      "이 커밋 뒤에 같은 부분을 또 고친 커밋이 있어서 자동으로 되돌릴 수 없어요. 아무것도 바뀌지 않았어요.",
      "A later commit changed the same lines, so this can't be reverted automatically. Nothing was changed."
    );
  }
  if (s.includes("conflict") || s.includes("automatic merge failed")) {
    return t(
      "같은 곳을 고친 커밋끼리 충돌했어요. 오른쪽에서 파일마다 어느 쪽을 쓸지 골라 주세요.",
      "Two commits changed the same lines. On the right, choose which version to keep for each file."
    );
  }
  if (s.includes("would be overwritten by checkout") || s.includes("would be overwritten by switch")) {
    return t(
      "고치던 파일이 저쪽 브랜치의 파일과 충돌해서 옮길 수 없어요. 먼저 커밋하거나 잠시 치워두세요.",
      "Your uncommitted changes clash with that branch's files. Commit or stash them before switching."
    );
  }
  if (
    s.includes("would be overwritten by merge") ||
    s.includes("your local changes") ||
    (s.includes("cannot pull") && s.includes("uncommitted"))
  ) {
    return t(
      "커밋 안 한 변경사항과 받아올 내용이 겹쳐요. 먼저 커밋해 주세요.",
      "Your uncommitted changes overlap with the incoming ones. Commit first."
    );
  }
  if (s.includes("repository not found") || (s.includes("repository") && s.includes("not found"))) {
    return t(
      "저장소를 찾을 수 없어요. 주소가 맞는지, 비공개 저장소라면 초대를 받았는지 확인해 주세요.",
      "Repository not found. Check the URL, and if it's private, make sure you've been invited."
    );
  }
  if (s.includes("already exists and is not an empty directory")) {
    return t(
      "그 자리에 같은 이름의 폴더가 이미 있어요. 다른 곳을 골라 주세요.",
      "A folder with that name already exists there. Pick another location."
    );
  }
  if (/permission to .* denied|requested url returned error: 403/.test(s)) {
    return t(
      "이 저장소에 올릴 권한이 없어요. 저장소 주인에게 팀원(Collaborator)으로 초대해 달라고 해 주세요.",
      "You don't have permission to push here. Ask the owner to add you as a collaborator."
    );
  }
  if (s.includes("permission denied (publickey)")) {
    return t(
      "SSH 키로 GitHub에 접속하지 못했어요. 저장소 주소를 https:// 로 시작하는 주소로 쓰면 GitHub 로그인으로 해결돼요.",
      "Couldn't connect to GitHub with your SSH key. Using an https:// repository URL lets GitHub sign-in handle it."
    );
  }
  if (s.includes("authentication failed") || s.includes("could not read username") || s.includes("terminal prompts disabled")) {
    return t(
      "GitHub 로그인이 필요해요. 위쪽의 [GitHub 로그인]을 누른 뒤 다시 해 주세요.",
      "You need to sign in to GitHub. Sign in, then try again."
    );
  }
  if (s.includes("could not resolve host") || s.includes("network is unreachable") || s.includes("timed out")) {
    return t("인터넷 연결을 확인해 주세요.", "Check your internet connection.");
  }
  if (
    s.includes("no configured push destination") ||
    s.includes("no such remote") ||
    s.includes("does not appear to be a git repository")
  ) {
    return t(
      "이 저장소에 GitHub 주소(remote)가 연결되어 있지 않아요.",
      "This repository isn't connected to GitHub (no remote)."
    );
  }
  if (s.includes("need to specify how to reconcile divergent branches")) {
    return t(
      "내 커밋과 GitHub의 커밋이 갈라져 있어요. 풀을 다시 눌러 주세요.",
      "Your commits and GitHub's have diverged. Press Pull again."
    );
  }
  if (s.includes("does not have any commits yet") || s.includes("unborn branch")) {
    return t("아직 커밋이 하나도 없어요. 먼저 커밋을 만들어 주세요.", "There are no commits yet. Make a commit first.");
  }

  return t("알 수 없는 문제가 생겼어요. 아래 원문을 확인해 주세요.", "Something went wrong. See the original message below.");
}
