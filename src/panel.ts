import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { CommitFile, GitService, RepoState } from "./gitService";
import { isMissingIdentity, translateGitError } from "./gitErrors";
import { getLang, t } from "./lang";
import { getGitHubAuth, isGitHubUrl, withGitHubLogin } from "./github";
import { webUrlFromRemote } from "./cloneUrl";

/** 시작할 때 보여주는 GitHub 로그인 안내를 "나중에"로 넘겼는지 */
export const LOGIN_SKIPPED = "easygit.loginSkipped";
/**
 * 윗줄에 늘 띄워 둘 브랜치. 브랜치 이름은 저장소마다 다르니 설정 파일이 아니라
 * 이 워크스페이스의 기억에만 담는다 (.vscode/settings.json을 건드리면 그게 '바뀐 파일'로 잡힌다).
 */
export const PINNED_BRANCHES = "easygit.pinnedBranches";
/** .gitignore 안내에서 "그냥 둘래요"를 고른 줄들. 저장소마다 다르니 워크스페이스에 기억한다 */
export const IGNORE_DISMISSED = "easygit.ignoreDismissed";

/** 웹뷰 → 확장 */
type InMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openFile"; path: string }
  | { type: "openDiff"; path: string }
  | { type: "commit"; paths: string[]; message: string }
  | { type: "push" }
  | { type: "pull" }
  | { type: "newBranch"; from?: string }
  | { type: "switchBranch"; name: string; remote: boolean }
  | { type: "init" }
  | { type: "clone" }
  | { type: "login" }
  | { type: "skipLogin" }
  | { type: "publish" }
  | { type: "undoCommit"; hash: string }
  | { type: "revertCommit"; hash: string }
  | { type: "setSkin"; skin: string }
  | { type: "commitFiles"; hash: string }
  | { type: "openCommitDiff"; hash: string; path: string; oldPath?: string }
  | { type: "pullBranch"; name: string }
  | { type: "updateFromMain" }
  | { type: "setIdentity"; name: string; email: string }
  | { type: "setPrefixes"; prefixes: string[] }
  | { type: "setWarnOnMain"; value: boolean }
  | { type: "setPinnedBranches"; branches: string[] }
  | { type: "switchAccount" }
  | { type: "resolveConflict"; path: string; side: "ours" | "theirs" }
  | { type: "editConflict"; path: string }
  | { type: "markResolved"; path: string }
  | { type: "compareConflict"; path: string }
  | { type: "finishMerge" }
  | { type: "abortMerge" }
  | { type: "openSponsor" }
  | { type: "openRepoPage" }
  | { type: "openPullRequest" }
  | { type: "popStash" }
  | { type: "discardFile"; path: string }
  | { type: "ignoreFiles"; patterns: string[] }
  | { type: "dismissIgnoreHint"; patterns: string[] }
  | { type: "setLanguage"; language: "ko" | "en" };

/** 확장 → 웹뷰 */
type OutMessage =
  | { type: "state"; state: RepoState }
  | { type: "error"; message: string; raw?: string }
  | {
      type: "config";
      commitPrefixes: string[];
      defaultPrefixes: string[];
      skin: string;
      warnOnMainBranch: boolean;
      /** 윗줄에 고정해 둔 브랜치 이름들 */
      pinnedBranches: string[];
      /** package.json의 sponsor.url. 비어 있으면 후원 버튼을 안 보여준다 */
      sponsorUrl: string | null;
      /** 실제로 쓰는 언어 */
      language: "ko" | "en";
      ignoreDismissed: string[];
      /** 설정값: auto면 VS Code 언어를 따른다 */
      languageSetting: string;
    }
  | { type: "identity"; name: string; email: string }
  | { type: "auth"; account: string | null; skipped: boolean }
  /** 취소한 커밋의 메시지를 커밋 칸에 다시 채워 넣기 */
  | { type: "prefill"; message: string }
  | { type: "commitFiles"; hash: string; files: CommitFile[] };

/** extension.ts의 easygit: 내용 제공자가 읽는 주소. ref가 null이면 빈 파일 */
function versionUri(ref: string | null, relPath: string): vscode.Uri {
  // 경로를 그대로 둬야 확장자로 문법 색이 입혀진다. ref가 다르면 주소도 달라야 VS Code가 따로 읽는다
  return vscode.Uri.from({ scheme: "easygit", path: "/" + relPath.split(path.sep).join("/"), query: JSON.stringify({ ref }) });
}

export class EasyGitPanel {
  public static current: EasyGitPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private identityAsked = false;

  static open(context: vscode.ExtensionContext, git: GitService) {
    if (EasyGitPanel.current) {
      EasyGitPanel.current.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "easygit.panel",
      "EasyGit",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      }
    );
    EasyGitPanel.current = new EasyGitPanel(panel, context, git);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitService
  ) {
    this.panel = panel;
    panel.webview.html = this.html();

    panel.webview.onDidReceiveMessage((m: InMessage) => this.onMessage(m), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 파일이 바뀌면 자동으로 다시 읽기 (너무 자주 안 읽도록 300ms 모아서)
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    watcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
    watcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
    watcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
    this.disposables.push(watcher);

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("easygit")) this.postConfig();
      },
      null,
      this.disposables
    );

    // 브라우저(GitHub)에서 머지하고 VS Code로 돌아오면 바로 보이도록, 창에 다시 들어올 때 받아온다
    vscode.window.onDidChangeWindowState(
      (e) => {
        if (e.focused && panel.visible) void this.fetchInBackground();
      },
      null,
      this.disposables
    );
    panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) void this.fetchInBackground();
      },
      null,
      this.disposables
    );

    // 푸시하다 로그인했거나, VS Code 계정 메뉴에서 로그아웃한 경우도 화면에 바로 반영
    vscode.authentication.onDidChangeSessions(
      (e) => {
        if (e.provider.id === "github") void this.postAuth();
      },
      null,
      this.disposables
    );
  }

  private lastFetch = 0;

  /** GitHub의 새 소식을 조용히 받아와 화면을 갱신. 너무 자주 하지 않게 30초에 한 번까지만 */
  private async fetchInBackground(force = false) {
    if (!force && Date.now() - this.lastFetch < 30_000) return;
    this.lastFetch = Date.now();
    const url = await this.git.remoteUrl();
    if (!url) return;
    const auth = isGitHubUrl(url) ? await getGitHubAuth(false) : undefined;
    await this.git.fetchQuietly(auth);
    await this.refresh();
  }

  private async postAuth() {
    const auth = await getGitHubAuth(false);
    this.post({
      type: "auth",
      account: auth?.user ?? null,
      skipped: this.context.globalState.get<boolean>(LOGIN_SKIPPED, false),
    });
  }

  private postConfig() {
    const config = vscode.workspace.getConfiguration("easygit");
    this.post({
      type: "config",
      commitPrefixes: config.get<string[]>("commitPrefixes", []),
      defaultPrefixes: config.inspect<string[]>("commitPrefixes")?.defaultValue ?? [],
      skin: config.get<string>("skin", "vscode"),
      warnOnMainBranch: config.get<boolean>("warnOnMainBranch", true),
      pinnedBranches: this.context.workspaceState.get<string[]>(PINNED_BRANCHES, []),
      sponsorUrl: this.sponsorUrl(),
      language: getLang(),
      ignoreDismissed: this.context.workspaceState.get<string[]>(IGNORE_DISMISSED, []),
      languageSetting: config.get<string>("language", "auto"),
    });
  }

  private sponsorUrl(): string | null {
    const url = this.context.extension.packageJSON?.sponsor?.url;
    return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
  }

  private async postIdentity() {
    this.post({ type: "identity", ...(await this.git.getIdentity()) });
  }

  /** 밖에서 강제로 갱신할 때 (저장 이벤트 등) */
  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 300);
  }

  private async refresh() {
    try {
      const state = await this.git.getState();
      this.post({ type: "state", state });
    } catch (e: any) {
      const raw = e?.message ?? String(e);
      this.post({ type: "error", message: translateGitError(raw), raw });
    }
  }

  /** git 동작 하나를 실행하고, 성공하면 화면 갱신 / 실패하면 쉬운 말로 이유 전달 */
  private async runAction(fn: () => Promise<void>) {
    try {
      await fn();
      await this.refresh();
    } catch (e: any) {
      const raw = e?.message ?? String(e);
      // 실패해도 git 상태는 바뀌었을 수 있다 (풀하다 충돌하면 "합치는 중"이 된다). 화면을 먼저 맞추고 이유를 알린다
      await this.refresh();
      this.post({ type: "error", message: translateGitError(raw), raw });
    }
  }

  /**
   * 화면에서 본 정보는 그 사이 바뀌었을 수 있으니, 기록을 건드리기 전에 git에 다시 물어본다.
   * 문제가 있으면 쉬운 말로 알려주고 undefined.
   */
  private async checkCommitTarget(hash: string) {
    const state = await this.git.getState();
    const commit = state.commits.find((c) => c.hash === hash);
    if (!commit) {
      // 화면을 먼저 새로 그리고 나서 알려야 안내가 지워지지 않는다
      await this.refresh();
      this.post({ type: "error", message: t("그 커밋을 찾지 못했어요. 화면을 다시 읽었어요.", "Couldn't find that commit. The view has been refreshed.") });
      return undefined;
    }
    if (!(await this.git.isOnCurrentBranch(hash))) {
      this.post({
        type: "error",
        message: t(
          `이 커밋은 지금 브랜치('${state.branch}')에 없어요. 그 커밋이 있는 브랜치로 먼저 옮겨 주세요.`,
          `This commit isn't on your current branch ('${state.branch}'). Switch to the branch that has it first.`
        ),
      });
      return undefined;
    }
    return { state, commit };
  }

  /** 아직 안 올린 커밋 취소 → 내용은 "바뀐 파일"로 → 원하면 다른 브랜치로 옮겨서 다시 커밋 */
  private async undoCommitFlow(hash: string) {
    const target = await this.checkCommitTarget(hash);
    if (!target) return;
    const { state, commit } = target;

    if (commit.parents.length === 0) {
      this.post({ type: "error", message: t("저장소의 맨 첫 커밋은 취소할 수 없어요.", "The very first commit of a repository can't be undone.") });
      return;
    }
    if (await this.git.isPushed(hash)) {
      await this.refresh();
      this.post({
        type: "error",
        message: t(
          "이 커밋은 이미 GitHub에 올라가 있어요. [ 만들기]를 써 주세요.",
          "This commit is already on GitHub. Use [Create a revert commit] instead."
        ),
      });
      return;
    }

    const after = await this.git.commitsAfter(hash);
    const UNDO = t("커밋 취소하기", "Undo commit");
    const pick = await vscode.window.showWarningMessage(
      t(`'${commit.subject}' 커밋을 취소할까요?`, `Undo the commit '${commit.subject}'?`),
      {
        modal: true,
        detail: t(
          `'${state.branch}' 브랜치가 이 커밋 전으로 돌아가요.\n` +
            "커밋에 담겼던 내용은 지워지지 않고 '바뀐 파일'로 돌아와요." +
            (after > 0 ? `\n\n이 커밋 뒤에 한 커밋 ${after}개도 같이 취소돼요. (그 내용도 '바뀐 파일'로 돌아와요)` : ""),
          `'${state.branch}' goes back to before this commit.\n` +
            "Nothing is deleted — the commit's changes come back as uncommitted files." +
            (after > 0 ? `\n\nThe ${after} commit(s) made after it are undone too (their changes also come back).` : "")
        ),
      },
      UNDO
    );
    if (pick !== UNDO) {
      await this.refresh();
      return;
    }

    const message = await this.git.commitMessage(hash);
    try {
      await this.git.undoCommit(hash);
    } catch (e: any) {
      const raw = e?.message ?? String(e);
      this.post({ type: "error", message: translateGitError(raw), raw });
      return;
    }
    await this.refresh();
    // 여러 개를 풀었으면 어떤 메시지를 다시 쓸지 애매하니, 한 개일 때만 채워 준다
    if (after === 0) this.post({ type: "prefill", message });

    const MOVE = t("다른 브랜치로 옮기기", "Move to another branch");
    const next = await vscode.window.showInformationMessage(
      t(
        "커밋을 취소했어요. 내용은 '바뀐 파일'에 그대로 있어요. 다른 브랜치에 커밋하려던 거라면 옮겨 드릴까요?",
        "Commit undone. Your changes are still in the file list. Meant to commit on another branch? I can move them."
      ),
      MOVE,
      t("여기 그대로 둘게요", "Keep them here")
    );
    if (next === MOVE) await this.moveChangesToBranch(state.branch);
  }

  /** 커밋 안 한 변경을 들고 다른 브랜치로 간다 (새 브랜치도 가능) */
  private async moveChangesToBranch(current: string) {
    const state = await this.git.getState();
    const NEW = t("$(add) 새 브랜치 만들기", "$(add) Create a new branch");
    const items = [
      { label: NEW, description: t(`'${current}'에서 갈라져 나온 새 브랜치`, `A new branch from '${current}'`) },
      ...state.branches.filter((b) => !b.remote && b.name !== current).map((b) => ({ label: b.name, description: "" })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: t("어느 브랜치로 옮길까요?", "Which branch should your changes go to?"),
      placeHolder: t("고친 내용을 들고 이 브랜치로 옮겨요. 옮긴 뒤 커밋을 누르면 돼요.", "Your changes come along. Commit after switching."),
    });
    if (!picked) return;
    if (picked.label === NEW) {
      await vscode.commands.executeCommand("easygit.newBranch");
      await this.refresh();
      return;
    }
    await this.runAction(() => this.git.switchBranch(picked.label, false));
  }

  /** 이미 올린 커밋 → 반대로 되돌리는 새 커밋 */
  private async revertCommitFlow(hash: string) {
    const target = await this.checkCommitTarget(hash);
    if (!target) return;
    const { commit } = target;

    const REVERT = t("이 커밋 취소", "Create a revert commit");
    const pick = await vscode.window.showWarningMessage(
      t(`'${commit.subject}' 커밋을 되돌릴까요?`, `Revert the commit '${commit.subject}'?`),
      {
        modal: true,
        detail: t(
          "이 커밋은 이미 GitHub에 올라가 있어서, 기록을 지우면 팀원들의 기록과 어긋나요.\n" +
            "대신 이 커밋이 바꾼 내용을 반대로 되돌리는 새 커밋을 만들어요. 만든 뒤 푸시하면 GitHub에도 반영돼요." +
            (commit.parents.length > 1 ? "\n\n브랜치를 합친 커밋이라, 합쳐 들어온 내용이 통째로 되돌려져요." : ""),
          "This commit is already on GitHub, so erasing it would break your teammates' history.\n" +
            "Instead, a new commit that undoes its changes is created. Push it to update GitHub." +
            (commit.parents.length > 1 ? "\n\nThis is a merge commit, so everything it brought in is undone." : "")
        ),
      },
      REVERT
    );
    if (pick !== REVERT) {
      await this.refresh();
      return;
    }
    await this.runAction(() => this.git.revertCommit(hash, commit.parents.length > 1));
  }

  /**
   * 브랜치 옮기기. 커밋 안 한 변경이 있으면 같이 가져갈지 잠시 치워둘지 묻는다.
   * 옮겼으면 true (취소하거나 실패하면 false)
   */
  private async switchFlow(name: string, remote: boolean): Promise<boolean> {
    const state = await this.git.getState();
    const target = remote ? name.replace(/^[^/]+\//, "") : name;
    let stashFirst = false;

    if (state.files.length > 0) {
      const CARRY = t("같이 가져가기", "Bring them along");
      const STASH = t("잠시 치워두기", "Stash them");
      const pick = await vscode.window.showWarningMessage(
        t(`커밋 안 한 변경 ${state.files.length}개가 있어요.`, `You have ${state.files.length} uncommitted change(s).`),
        {
          modal: true,
          detail: t(
            `'${target}' 브랜치로 옮길 때 이 변경들을 어떻게 할까요?\n\n` +
              `• ${CARRY}: 고치던 내용을 그대로 들고 가요.\n` +
              `• ${STASH}: '${state.branch}'에 잠시 치워두고 깨끗한 상태로 옮겨요. 나중에 다시 꺼낼 수 있어요.`,
            `What should happen to them when switching to '${target}'?\n\n` +
              `• ${CARRY}: keep working on them on the new branch.\n` +
              `• ${STASH}: set them aside on '${state.branch}' and switch with a clean slate. You can get them back later.`
          ),
        },
        CARRY,
        STASH
      );
      if (!pick) {
        await this.refresh();
        return false;
      }
      stashFirst = pick === STASH;
    }

    try {
      if (stashFirst) await this.git.stash(t(`${state.branch}에서 잠시 치워둠`, `Stashed on ${state.branch}`));
      await this.git.switchBranch(name, remote);
      await this.refresh();
      return true;
    } catch (e: any) {
      const raw = e?.message ?? String(e);
      this.post({ type: "error", message: translateGitError(raw), raw });
      return false;
    }
  }

  /** 이 브랜치를 메인에 합쳐 달라는 PR 작성 페이지. GitHub 저장소가 아니면 null */
  private async pullRequestUrl(): Promise<string | null> {
    const remote = await this.git.remoteUrl();
    const page = remote && webUrlFromRemote(remote);
    if (!page || !/^https:\/\/(www\.)?github\.com\//i.test(page)) return null;
    const state = await this.git.getState();
    const enc = (b: string) => b.split("/").map(encodeURIComponent).join("/");
    // 이미 열린 PR이 있으면 GitHub이 이 화면 위쪽에 그 PR로 가는 링크를 보여준다
    return `${page}/compare/${enc(state.mainBranch)}...${enc(state.branch)}?expand=1`;
  }

  /** 지금 브랜치에 치워둔 변경 중 가장 최근 것을 다시 꺼낸다 */
  private async popStashFlow() {
    const state = await this.git.getState();
    const stash = state.stashes.find((s) => s.branch === state.branch);
    if (!stash) return this.refresh();
    if (state.files.length > 0) {
      await this.refresh();
      this.post({
        type: "error",
        message: t(
          "지금 커밋 안 한 변경이 있어서 꺼낼 수 없어요. 먼저 커밋하고 다시 눌러 주세요.",
          "You have uncommitted changes. Commit them first, then try again."
        ),
      });
      return;
    }
    try {
      await this.git.popStash(stash.ref);
      await this.refresh();
    } catch (e: any) {
      await this.refresh();
      this.post({
        type: "error",
        message: t(
          "치워둔 뒤로 같은 곳이 바뀌어서 꺼내지 못했어요. 파일은 꺼내기 전 그대로이고, 치워둔 변경도 남아 있어요.",
          "The same lines changed since you stashed, so it couldn't be restored. Nothing changed and the stash is still there."
        ),
        raw: e?.message ?? String(e),
      });
    }
  }

  /** 파일 하나의 변경을 버린다. 새 파일은 휴지통으로 보내서 실수해도 꺼낼 수 있게 한다 */
  private async discardFlow(filePath: string) {
    const state = await this.git.getState();
    const file = state.files.find((f) => f.path === filePath);
    if (!file) return this.refresh();
    const isNew = file.label === "added";
    const DISCARD = t("변경 버리기", "Discard changes");
    const pick = await vscode.window.showWarningMessage(
      t(`'${filePath}'의 변경을 버릴까요?`, `Discard changes to '${filePath}'?`),
      {
        modal: true,
        detail: isNew
          ? t("새로 만든 파일이라 휴지통으로 옮겨요. 필요하면 휴지통에서 다시 꺼낼 수 있어요.", "It's a new file, so it moves to the trash. You can restore it from there.")
          : t(
              "마지막 커밋 상태로 돌아가요. 커밋하지 않은 고친 내용은 사라지고 되살릴 수 없어요.",
              "The file goes back to how it was in the last commit. Your uncommitted edits are lost for good."
            ),
      },
      DISCARD
    );
    if (pick !== DISCARD) return;
    await this.runAction(async () => {
      await this.git.discard(file);
      if (isNew) {
        const uri = vscode.Uri.file(path.join(this.git.root, filePath));
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      }
    });
  }

  /** .gitignore에 줄을 더한다. 이미 있는 줄은 다시 적지 않는다 */
  private async addToGitignore(patterns: string[]) {
    const uri = vscode.Uri.file(path.join(this.git.root, ".gitignore"));
    let text = "";
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      /* 아직 없으면 새로 만든다 */
    }
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const add = patterns.filter((p) => !have.has(p));
    if (add.length === 0) return;
    const next = text + (text && !text.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n";
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next, "utf8"));
  }

  /** 커밋에 남을 이름·이메일을 받아 저장한다. 취소하면 false */
  private async askIdentity(): Promise<boolean> {
    const name = await vscode.window.showInputBox({
      title: t("커밋에 남길 이름 (1/2) — 처음 한 번만", "Your name for commits (1/2) — one time only"),
      prompt: t(
        "커밋마다 누가 했는지 이 이름이 남아요. 팀원이 알아볼 수 있는 이름이면 돼요. (Esc를 누르면 건너뛰어요)",
        "Every commit records who made it. Use a name your teammates will recognize. (Esc to skip)"
      ),
      placeHolder: t("예: 김연비", "e.g. Alex Kim"),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : t("이름을 적어 주세요.", "Enter a name.")),
    });
    if (!name) return false;

    const email = await vscode.window.showInputBox({
      title: t("커밋에 남길 이메일 (2/2)", "Your email for commits (2/2)"),
      prompt: t(
        "GitHub 계정에 등록한 이메일을 넣으면 GitHub에서 내 커밋으로 표시돼요.",
        "Use the email on your GitHub account so GitHub links these commits to you."
      ),
      placeHolder: t("예: me@example.com", "e.g. me@example.com"),
      ignoreFocusOut: true,
      validateInput: (v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? undefined : t("이메일 모양으로 적어 주세요.", "That doesn't look like an email.")),
    });
    if (!email) return false;

    await this.git.setIdentity(name.trim(), email.trim());
    return true;
  }

  private post(m: OutMessage) {
    if (this.disposed) return; // 창을 닫은 뒤 늦게 끝난 fetch 등
    this.panel.webview.postMessage(m);
  }

  private async onMessage(m: InMessage) {
    switch (m.type) {
      case "ready":
      case "refresh":
        this.postConfig();
        void this.postAuth();
        void this.postIdentity();
        await this.refresh();
        // fetch는 느리거나 멈출 수 있으니 화면을 먼저 그리고 뒤에서 돌린다. 끝나면 한 번 더 갱신.
        // 여기서는 로그인 창을 절대 띄우지 않는다 — 로그인해 둔 게 있을 때만 쓴다.
        void this.fetchInBackground(true);
        break;
      case "login":
        await getGitHubAuth(true);
        await this.postAuth();
        break;
      case "resolveConflict":
        await this.runAction(() => this.git.resolveWith(m.path, m.side));
        break;
      case "editConflict":
        // 충돌 표시(<<<<<<<)가 그대로 보이는 보통 편집기로 연다. VS Code는 충돌한 파일을
        // 3칸짜리 '병합 편집기'로 바꿔 열 때가 있는데, 거기선 양옆 칸이 읽기 전용이라
        // "두 쪽을 지우고 새로 쓰기"가 아예 안 되고 화면 안내와도 안 맞는다.
        // 보통 편집기에서는 충돌한 곳마다 [현재 변경 수락] [수신 변경 수락] 버튼이 뜬다.
        await vscode.commands.executeCommand(
          "vscode.openWith",
          vscode.Uri.file(path.join(this.git.root, m.path)),
          "default",
          { viewColumn: vscode.ViewColumn.Beside }
        );
        break;
      case "markResolved": {
        let left = 0;
        await this.runAction(async () => {
          // 저장 안 한 편집이 있으면 그걸로 판단해야 하니 먼저 저장
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(this.git.root, m.path));
          if (doc?.isDirty) await doc.save();
          left = await this.git.markResolved(m.path);
        });
        if (left > 0) {
          this.post({
            type: "error",
            message: t(
              `'${path.basename(m.path)}'에 아직 고칠 곳이 ${left}개 남았어요. <<<<<<< 부터 >>>>>>> 까지를 원하는 내용으로 바꿔 주세요.`,
              `'${path.basename(m.path)}' still has ${left} conflict(s). Replace everything from <<<<<<< to >>>>>>> with what you want.`
            ),
          });
        }
        break;
      }
      case "compareConflict":
        await vscode.commands.executeCommand(
          "vscode.diff",
          versionUri(":2", m.path),
          versionUri(":3", m.path),
          t(`${path.basename(m.path)} (내 거 ↔ 팀원 거)`, `${path.basename(m.path)} (mine ↔ theirs)`),
          { viewColumn: vscode.ViewColumn.Beside, preview: true }
        );
        break;
      case "setLanguage":
        await vscode.workspace.getConfiguration("easygit").update("language", m.language, vscode.ConfigurationTarget.Global);
        break;
      case "openRepoPage": {
        const remote = await this.git.remoteUrl();
        const url = remote && webUrlFromRemote(remote);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case "openPullRequest": {
        const url = await this.pullRequestUrl();
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case "popStash":
        await this.popStashFlow();
        break;
      case "discardFile":
        await this.discardFlow(m.path);
        break;
      case "ignoreFiles":
        await this.runAction(() => this.addToGitignore(m.patterns));
        break;
      case "dismissIgnoreHint": {
        const prev = this.context.workspaceState.get<string[]>(IGNORE_DISMISSED, []);
        await this.context.workspaceState.update(IGNORE_DISMISSED, [...new Set([...prev, ...m.patterns])]);
        this.postConfig();
        break;
      }
      case "openSponsor": {
        const url = this.sponsorUrl();
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case "finishMerge":
        await this.runAction(() => this.git.finishMerge());
        break;
      case "abortMerge": {
        const STOP = t("합치기 취소", "Cancel merge");
        const pick = await vscode.window.showWarningMessage(
          t("합치기를 취소할까요?", "Cancel this merge?"),
          {
            modal: true,
            detail: t(
              "풀 하기 전 상태로 돌아가요. 지금까지 고른 내용은 사라지고, GitHub의 새 커밋은 아직 안 받은 상태가 돼요.",
              "Everything goes back to how it was before. Your choices so far are discarded and the new commits aren't brought in."
            ),
          },
          STOP
        );
        if (pick === STOP) await this.runAction(() => this.git.abortMerge());
        else await this.refresh();
        break;
      }
      case "switchAccount":
        await getGitHubAuth(true, true);
        await this.postAuth();
        break;
      case "setIdentity":
        try {
          await this.git.setIdentity(m.name.trim(), m.email.trim());
        } catch (e: any) {
          this.post({ type: "error", message: t("이름·이메일을 저장하지 못했어요.", "Couldn't save your name and email."), raw: e?.message ?? String(e) });
        }
        await this.postIdentity();
        break;
      case "setPrefixes":
        await vscode.workspace.getConfiguration("easygit").update("commitPrefixes", m.prefixes, vscode.ConfigurationTarget.Global);
        break;
      case "setWarnOnMain":
        await vscode.workspace.getConfiguration("easygit").update("warnOnMainBranch", m.value, vscode.ConfigurationTarget.Global);
        break;
      case "setPinnedBranches":
        // 워크스페이스 기억은 설정 바뀜 알림이 안 오니 직접 다시 보내 준다
        await this.context.workspaceState.update(PINNED_BRANCHES, m.branches);
        this.postConfig();
        break;
      case "pullBranch":
        // GitHub에 새 커밋이 있는 브랜치로 (필요하면) 옮기고 바로 풀까지
        if (m.name !== (await this.git.currentBranch())) {
          const local = (await this.git.getState()).branches.some((b) => !b.remote && b.name === m.name);
          if (!(await this.switchFlow(local ? m.name : `origin/${m.name}`, !local))) break;
        }
        await this.runAction(async () => {
          const url = await this.git.remoteUrl();
          await withGitHubLogin(url, t("이 저장소에서 받아오려면 내 계정으로 로그인해야 해요.", "Sign in to pull from this repository."), (auth) =>
            this.git.pull(auth)
          );
        });
        break;
      case "updateFromMain": {
        const state = await this.git.getState();
        if (state.files.length > 0) {
          await this.refresh();
          this.post({
            type: "error",
            message: t("커밋 안 한 변경이 있으면 받아올 수 없어요. 먼저 커밋해 주세요.", "Commit your changes before bringing in the latest updates."),
          });
          break;
        }
        const GO = t("받아오기", "Update");
        const pick = await vscode.window.showInformationMessage(
          t(`${state.mainBranch}의 최신 내용을 '${state.branch}'에 받아올까요?`, `Bring the latest ${state.mainBranch} into '${state.branch}'?`),
          {
            modal: true,
            detail: t(
              `${state.mainBranch}에 새로 합쳐진 커밋을 '${state.branch}' 브랜치로 합쳐요. ${state.mainBranch}는 바뀌지 않아요.\n` +
                "같은 곳을 고친 곳이 있으면 어느 쪽을 쓸지 고르는 화면이 떠요. 끝나면 푸시해서 PR에 반영하면 돼요.",
              `New commits on ${state.mainBranch} are merged into '${state.branch}'. ${state.mainBranch} itself doesn't change.\n` +
                "If the same lines were changed, you'll pick which version to keep. Then push to update your PR."
            ),
          },
          GO
        );
        if (pick !== GO) {
          await this.refresh();
          break;
        }
        await this.runAction(async () => {
          const url = await this.git.remoteUrl();
          await withGitHubLogin(url, t("최신 내용을 받아오려면 내 계정으로 로그인해야 해요.", "Sign in to bring in the latest updates."), (auth) =>
            this.git.mergeFromMain(state.mainBranch, auth)
          );
        });
        break;
      }
      case "skipLogin":
        await this.context.globalState.update(LOGIN_SKIPPED, true);
        await this.postAuth();
        break;
      case "publish":
        await vscode.commands.executeCommand("easygit.publish");
        await this.refresh();
        break;
      case "undoCommit":
        await this.undoCommitFlow(m.hash);
        break;
      case "revertCommit":
        await this.revertCommitFlow(m.hash);
        break;
      case "commitFiles":
        try {
          this.post({ type: "commitFiles", hash: m.hash, files: await this.git.commitFiles(m.hash) });
        } catch (e: any) {
          const raw = e?.message ?? String(e);
          this.post({ type: "error", message: t("이 커밋의 파일 목록을 읽지 못했어요.", "Couldn't read this commit's files."), raw });
        }
        break;
      case "openCommitDiff": {
        // 커밋 바로 전 ↔ 커밋 직후. 새로 생긴 파일은 왼쪽이, 지운 파일은 오른쪽이 빈 화면으로 보인다
        await vscode.commands.executeCommand(
          "vscode.diff",
          versionUri(`${m.hash}^`, m.oldPath ?? m.path),
          versionUri(m.hash, m.path),
          t(`${path.basename(m.path)} (${m.hash.slice(0, 7)} 커밋 전 ↔ 후)`, `${path.basename(m.path)} (${m.hash.slice(0, 7)} before ↔ after)`),
          { viewColumn: vscode.ViewColumn.Beside, preview: true }
        );
        break;
      }
      case "setSkin":
        // 설정에 저장해 두면 다음에 열어도 유지되고, 설정 화면에서도 보인다 (바뀌면 postConfig가 다시 보냄)
        await vscode.workspace.getConfiguration("easygit").update("skin", m.skin, vscode.ConfigurationTarget.Global);
        break;
      case "openFile": {
        const uri = vscode.Uri.file(path.join(this.git.root, m.path));
        await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
        break;
      }
      case "openDiff": {
        // 마지막 커밋 ↔ 지금 파일. 지운 파일은 지금 쪽이 빈 화면
        const fileUri = vscode.Uri.file(path.join(this.git.root, m.path));
        let exists = true;
        try {
          await vscode.workspace.fs.stat(fileUri);
        } catch {
          exists = false;
        }
        await vscode.commands.executeCommand(
          "vscode.diff",
          versionUri("HEAD", m.path),
          exists ? fileUri : versionUri(null, m.path),
          t(`${path.basename(m.path)} (마지막 커밋 ↔ 지금)`, `${path.basename(m.path)} (last commit ↔ now)`),
          { viewColumn: vscode.ViewColumn.Beside }
        );
        break;
      }
      case "commit":
        await this.runAction(async () => {
          // 창을 연 동안 한 번만 묻는다. 건너뛰어도 커밋은 진행한다 (git이 알아서 채울 수 있으면)
          if (!this.identityAsked && !(await this.git.hasIdentity())) {
            this.identityAsked = true;
            await this.askIdentity();
          }
          try {
            await this.git.commit(m.paths, m.message);
          } catch (e: any) {
            // git이 이름·이메일을 추측조차 못 하는 컴퓨터에서는 여기서 막힌다. 받고 다시 시도한다.
            if (!isMissingIdentity(e?.message ?? "") || !(await this.askIdentity())) throw e;
            await this.git.commit(m.paths, m.message);
          }
        });
        break;
      case "push": {
        const state = await this.git.getState();
        const YES = t("네, 올릴게요", "Yes, push");
        const pick = await vscode.window.showWarningMessage(
          t("이거 팀 저장소에 올라가요.", "This goes to your team's repository."),
          {
            modal: true,
            detail: state.hasUpstream
              ? t(
                  `커밋한 내용이 GitHub의 ${state.branch} 브랜치에 올라가고, 팀원 모두가 볼 수 있게 돼요.`,
                  `Your commits go to the ${state.branch} branch on GitHub, where everyone on the team can see them.`
                )
              : t(
                  `커밋한 내용이 GitHub에 새로 만들어지는 ${state.branch} 브랜치에 올라가고, 팀원 모두가 볼 수 있게 돼요.`,
                  `A new ${state.branch} branch is created on GitHub with your commits, where everyone on the team can see them.`
                ),
          },
          YES
        );
        // 취소하면 상태만 다시 보내서 화면의 "올리는 중" 표시를 푼다
        if (pick !== YES) {
          await this.refresh();
          break;
        }
        await this.runAction(async () => {
          const url = await this.git.remoteUrl();
          await withGitHubLogin(url, t("GitHub에 올리려면 내 계정으로 로그인해야 해요.", "Sign in to push to GitHub."), (auth) =>
            this.git.push(auth)
          );
        });
        break;
      }
      case "pull":
        await this.runAction(async () => {
          const url = await this.git.remoteUrl();
          await withGitHubLogin(url, t("이 저장소에서 받아오려면 내 계정으로 로그인해야 해요.", "Sign in to pull from this repository."), (auth) =>
            this.git.pull(auth)
          );
        });
        break;
      case "newBranch":
        await vscode.commands.executeCommand("easygit.newBranch", m.from);
        await this.refresh();
        break;
      case "init": {
        const root = path.resolve(this.git.root);
        // 홈 폴더 전체를 저장소로 만들면 컴퓨터의 모든 파일이 "바뀐 파일"로 잡히는 사고가 난다
        if (root === path.resolve(os.homedir()) || root === path.parse(root).root) {
          await vscode.window.showWarningMessage(t("이 폴더는 너무 넓어요.", "This folder is too broad."), {
            modal: true,
            detail: t(
              "홈 폴더나 디스크 전체를 저장소로 만들면 컴퓨터의 모든 파일이 기록 대상이 돼요. 프로젝트용 폴더를 하나 만들어서 그 폴더를 열어 주세요.",
              "Making your home folder or whole disk a repository would track every file on your computer. Create a project folder and open that instead."
            ),
          });
          await this.refresh();
          break;
        }
        const MAKE = t("저장소로 만들기", "Create repository");
        const pick = await vscode.window.showInformationMessage(
          t(`'${path.basename(root)}' 폴더를 git 저장소로 만들까요?`, `Turn '${path.basename(root)}' into a git repository?`),
          {
            modal: true,
            detail: t(
              "폴더 안의 파일은 그대로예요. 이제부터 무엇을 바꿨는지 기록할 수 있게 준비만 해요.\n" +
                "(폴더 안에 숨김 폴더 .git 이 생겨요. 지우면 기록이 사라지니 건드리지 마세요.)",
              "Your files stay as they are. This just starts keeping a history of your changes.\n" +
                "(A hidden .git folder is created. Don't delete it, or the history is lost.)"
            ),
          },
          MAKE
        );
        if (pick !== MAKE) {
          await this.refresh();
          break;
        }
        await this.runAction(() => this.git.init());
        break;
      }
      case "clone":
        await vscode.commands.executeCommand("easygit.clone");
        await this.refresh();
        break;
      case "switchBranch":
        await this.switchFlow(m.name, m.remote);
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>EasyGit</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose() {
    this.disposed = true;
    EasyGitPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
