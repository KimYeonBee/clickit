import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitService } from "./gitService";
import { EasyGitPanel } from "./panel";
import { translateGitError } from "./gitErrors";
import { checkCloneUrl, normalizeCloneUrl, repoNameFromUrl, webUrlFromRemote } from "./cloneUrl";
import { Lang, setLang, t } from "./lang";
import {
  FriendlyError,
  askGitHubLogin,
  checkRepoName,
  createGitHubRepo,
  getGitHubAuth,
  suggestRepoName,
  withGitHubLogin,
} from "./github";

/** 가져온 저장소를 열면 창이 새로 뜨므로, 그 창에서 EasyGit을 바로 열어주려고 남겨두는 표시 */
const OPEN_AFTER_CLONE = "easygit.openAfterClone";

let cachedGit: GitService | undefined;

/** 열린 폴더가 없으면 undefined. 명령은 폴더가 없어도 등록돼 있어야 눌렀을 때 안내할 수 있다 */
function currentGit(): GitService | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  if (cachedGit?.folder !== root) cachedGit = new GitService(root);
  return cachedGit;
}

/** 설정(easygit.language)이 auto면 VS Code 표시 언어가 한국어일 때만 한국어 */
function resolveLang(): Lang {
  const v = vscode.workspace.getConfiguration("easygit").get<string>("language", "auto");
  if (v === "ko" || v === "en") return v;
  return vscode.env.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

async function askToOpenFolder() {
  const OPEN = t("폴더 열기", "Open folder");
  const CLONE = t("GitHub 저장소 가져오기", "Clone from GitHub");
  const pick = await vscode.window.showInformationMessage(
    t(
      "EasyGit은 폴더 안에서 동작해요. 작업할 프로젝트 폴더를 열거나, GitHub에서 가져와 주세요.",
      "EasyGit works inside a folder. Open your project folder or clone one from GitHub."
    ),
    OPEN,
    CLONE
  );
  if (pick === OPEN) await vscode.commands.executeCommand("vscode.openFolder");
  else if (pick === CLONE) await vscode.commands.executeCommand("easygit.clone");
}

export function activate(context: vscode.ExtensionContext) {
  setLang(resolveLang());
  const launcher = new LauncherView(context.extensionUri);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("easygit.language")) return;
      setLang(resolveLang());
      launcher.render();
    })
  );

  // 비교 화면의 "예전 버전" 쪽 내용. easygit:/경로?{"ref":"커밋^"} → git show 커밋^:경로 (없으면 빈 화면)
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("easygit", {
      provideTextDocumentContent: async (uri) => {
        const git = currentGit();
        const ref: string | null = JSON.parse(uri.query || "{}").ref ?? null;
        if (!git || !ref) return "";
        return git.showFile(ref, uri.path.replace(/^\//, ""));
      },
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("easygit.clone", () => cloneFlow(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("easygit.publish", () => {
      const git = currentGit();
      if (!git) return askToOpenFolder();
      return publishFlow(git);
    })
  );

  const pending = context.globalState.get<string>(OPEN_AFTER_CLONE);
  const opened = currentGit();
  if (pending && opened && path.resolve(pending) === path.resolve(opened.folder)) {
    void context.globalState.update(OPEN_AFTER_CLONE, undefined);
    EasyGitPanel.open(context, opened);
  }

  // 명령 팔레트 / 버튼에서 큰 창 열기
  context.subscriptions.push(
    vscode.commands.registerCommand("easygit.open", () => {
      const git = currentGit();
      if (!git) return askToOpenFolder();
      EasyGitPanel.open(context, git);
    })
  );

  // 새 브랜치 만들기 — 큰 창의 버튼과 main 경고 알림이 같이 쓴다
  context.subscriptions.push(
    vscode.commands.registerCommand("easygit.newBranch", (from?: string) => {
      const git = currentGit();
      if (!git) return askToOpenFolder();
      return newBranchFlow(git, from);
    })
  );

  // 왼쪽 사이드바: "열기" 버튼 하나만 있는 작은 화면
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("easygit.launcher", launcher)
  );

  // 파일 저장하면 패널 갱신 + main 브랜치 경고 (3단계에서 UI 붙일 자리, 지금은 동작만)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async () => {
      EasyGitPanel.current?.scheduleRefresh();
      const git = currentGit();
      if (git) await maybeWarnMainBranch(git);
    })
  );
}

const warnedThisSession = new Set<string>();
let lastBranch: string | undefined;

async function maybeWarnMainBranch(git: GitService) {
  const enabled = vscode.workspace.getConfiguration("easygit").get<boolean>("warnOnMainBranch", true);
  if (!enabled) return;
  const b = await git.currentBranch();
  if (!b) return;

  // 브랜치를 옮겼으면 다시 한 번 물어볼 가치가 있다
  if (lastBranch !== undefined && lastBranch !== b) warnedThisSession.clear();
  lastBranch = b;

  if (!["main", "master"].includes(b) || warnedThisSession.has(b)) return;
  warnedThisSession.add(b);

  const NEW = t("새 브랜치 만들기", "Create a branch");
  const OPEN = t("EasyGit 열기", "Open EasyGit");
  const pick = await vscode.window.showWarningMessage(
    t(`지금 '${b}' 브랜치에서 작업 중이에요. 여기서 하는 게 맞나요?`, `You're working on '${b}'. Is that the right branch?`),
    t("네, 계속할게요", "Yes, continue"),
    NEW,
    OPEN
  );
  if (pick === NEW) await newBranchFlow(git);
  else if (pick === OPEN) vscode.commands.executeCommand("easygit.open");
}

/** GitHub 저장소 주소 → 저장할 곳 → 복사 → 열기 */
async function cloneFlow(context: vscode.ExtensionContext) {
  const input = await vscode.window.showInputBox({
    title: t("GitHub 저장소 가져오기 (1/2)", "Clone from GitHub (1/2)"),
    prompt: t(
      "GitHub 저장소 페이지의 초록색 [Code] 버튼을 누르면 나오는 주소를 붙여 넣어요. 페이지 주소를 그대로 넣어도 돼요.",
      "Paste the URL from the green [Code] button on the repository page. The page URL works too."
    ),
    placeHolder: t("https://github.com/아이디/저장소이름", "https://github.com/user/repo"),
    ignoreFocusOut: true,
    validateInput: checkCloneUrl,
  });
  if (!input) return;
  const url = normalizeCloneUrl(input);
  const name = repoNameFromUrl(url);

  const where = await vscode.window.showOpenDialog({
    title: t(`GitHub 저장소 가져오기 (2/2) — '${name}' 폴더를 어디 안에 만들까요?`, `Clone from GitHub (2/2) — where should the '${name}' folder go?`),
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: t("여기 안에 만들기", "Clone here"),
    defaultUri: vscode.Uri.file(os.homedir()),
  });
  if (!where?.[0]) return;
  const parent = where[0].fsPath;
  const target = path.join(parent, name);

  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    vscode.window.showWarningMessage(
      t(`'${parent}' 안에 이미 '${name}' 폴더가 있어요. 다른 곳을 골라 주세요.`, `'${parent}' already has a '${name}' folder. Pick another location.`)
    );
    return;
  }

  try {
    // 공개 저장소는 로그인 없이 바로 가져오고, 비공개라서 막히면 그때 로그인을 받는다
    await withGitHubLogin(
      url,
      t(
        "이 저장소를 찾지 못했어요. 비공개 저장소라면 초대받은 계정으로 로그인하면 가져올 수 있어요.",
        "Couldn't find this repository. If it's private, sign in with an account that has access."
      ),
      async (auth) =>
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t(`'${name}' 가져오는 중…`, `Cloning '${name}'…`) },
          () => GitService.clone(url, parent, name, auth)
        )
    );
  } catch (e: any) {
    await showErrorWithRaw(translateGitError(e?.message ?? String(e)), e?.message ?? String(e));
    return;
  }

  const HERE = t("이 창에서 열기", "Open here");
  const NEW = t("새 창에서 열기", "Open in new window");
  const pick = await vscode.window.showInformationMessage(
    t(`'${name}'을(를) 가져왔어요. 열어서 작업을 시작할까요?`, `Cloned '${name}'. Open it now?`),
    HERE,
    NEW
  );
  if (!pick) return;
  await context.globalState.update(OPEN_AFTER_CLONE, target);
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), {
    forceNewWindow: pick === NEW,
  });
}

async function showErrorWithRaw(message: string, raw: string) {
  const RAW = t("원문 보기", "Show details");
  const pick = await vscode.window.showErrorMessage(message, RAW);
  if (pick === RAW) await vscode.window.showErrorMessage(t("원문", "Details"), { modal: true, detail: raw });
}

/** 내 컴퓨터에서만 기록하던 저장소를 GitHub에 새 저장소로 만들어 올린다. 로그인이 꼭 필요한 일 */
async function publishFlow(git: GitService): Promise<void> {
  const state = await git.getState();
  if (!state.isRepo) return;
  if (state.hasRemote) {
    vscode.window.showInformationMessage(t("이미 GitHub(원격)에 연결된 저장소예요. 푸시를 누르면 올라가요.", "This repository is already connected to GitHub. Just press Push."));
    return;
  }
  if (state.commits.length === 0) {
    vscode.window.showInformationMessage(t("먼저 첫 커밋을 해 주세요. 올릴 기록이 있어야 GitHub에 올릴 수 있어요.", "Make your first commit first — there's nothing to publish yet."));
    return;
  }

  const how = await vscode.window.showQuickPick(
    [
      {
        label: t("$(add) 새 저장소 만들기", "$(add) Create a new repository"),
        description: t("EasyGit이 GitHub에 저장소를 만들어서 올려요", "EasyGit creates it on GitHub for you"),
        connect: false,
      },
      {
        label: t("$(link) 이미 만든 저장소에 연결하기", "$(link) Connect a repository you made"),
        description: t("GitHub 웹에서 먼저 만들어 둔 빈 저장소 주소를 넣어요", "Paste the URL of an empty repository you created on GitHub"),
        connect: true,
      },
    ],
    { title: t("GitHub에 올리기", "Publish to GitHub"), ignoreFocusOut: true }
  );
  if (!how) return;
  if (how.connect) return connectFlow(git);

  const auth =
    (await getGitHubAuth(false)) ??
    (await askGitHubLogin(t("GitHub에 새 저장소를 만들려면 내 계정으로 로그인해야 해요.", "Sign in to create a repository on GitHub.")));
  if (!auth) return;

  let name = suggestRepoName(state.folder);
  for (;;) {
    const input = await vscode.window.showInputBox({
      title: t("GitHub에 올리기 (1/2) — 저장소 이름", "Publish to GitHub (1/2) — repository name"),
      prompt: t(
        `github.com/${auth.user}/이름 주소로 만들어져요. 영문·숫자·- _ . 만 쓸 수 있어요.`,
        `It will live at github.com/${auth.user}/name. Use letters, numbers, - _ . only.`
      ),
      value: name,
      ignoreFocusOut: true,
      validateInput: checkRepoName,
    });
    if (!input) return;
    name = input.trim();

    const visibility = await vscode.window.showQuickPick(
      [
        { label: t("$(lock) 비공개", "$(lock) Private"), description: t("나와 초대한 사람만 볼 수 있어요", "Only you and people you invite"), isPrivate: true },
        {
          label: t("$(globe) 공개", "$(globe) Public"),
          description: t("누구나 볼 수 있어요. 포트폴리오로 보여줄 거라면 이쪽", "Anyone can see it — good for a portfolio"),
          isPrivate: false,
        },
      ],
      { title: t("GitHub에 올리기 (2/2) — 누가 볼 수 있나요?", "Publish to GitHub (2/2) — who can see it?"), ignoreFocusOut: true }
    );
    if (!visibility) return;

    const GO = t("만들고 올리기", "Create and publish");
    const ok = await vscode.window.showWarningMessage(
      t(
        `GitHub에 '${name}' 저장소를 ${visibility.isPrivate ? "비공개" : "공개"}로 만들고 올릴까요?`,
        `Create a ${visibility.isPrivate ? "private" : "public"} repository '${name}' on GitHub and publish?`
      ),
      {
        modal: true,
        detail:
          t(`지금까지의 커밋이 github.com/${auth.user}/${name} 에 올라가요.`, `Your commits will be uploaded to github.com/${auth.user}/${name}.`) +
          (visibility.isPrivate
            ? ""
            : t(
                "\n\n공개 저장소는 누구나 코드를 볼 수 있어요. 비밀번호나 API 키가 든 파일이 커밋돼 있지 않은지 확인해 주세요.",
                "\n\nAnyone can read a public repository. Make sure no passwords or API keys are committed."
              )),
      },
      GO
    );
    if (ok !== GO) return;

    try {
      const repo = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("GitHub에 올리는 중…", "Publishing to GitHub…") },
        async () => {
          const created = await createGitHubRepo(auth, name, visibility.isPrivate);
          await git.addRemote(created.cloneUrl);
          await git.push(auth);
          return created;
        }
      );
      EasyGitPanel.current?.scheduleRefresh();
      const VIEW = t("GitHub에서 보기", "View on GitHub");
      const pick = await vscode.window.showInformationMessage(
        t("올렸어요! 이제 이 저장소는 GitHub과 연결됐어요. 다음부터는 푸시만 누르면 돼요. 윗줄 GitHub 옆 ↗ 로 언제든 저장소를 열 수 있어요.", "Published! This repository is now connected to GitHub. From now on, just press Push. Use ↗ next to GitHub at the top to open the repository anytime."),
        VIEW
      );
      if (pick === VIEW) await vscode.env.openExternal(vscode.Uri.parse(repo.htmlUrl));
      return;
    } catch (e: any) {
      if (e instanceof FriendlyError && e.nameTaken) {
        vscode.window.showWarningMessage(e.message);
        continue; // 이름만 다시 받는다
      }
      const raw = e instanceof FriendlyError ? e.raw : e?.message ?? String(e);
      const message = e instanceof FriendlyError ? e.message : translateGitError(raw);
      EasyGitPanel.current?.scheduleRefresh();
      await showErrorWithRaw(message, raw);
      return;
    }
  }
}

/**
 * GitHub 웹에서 먼저 만든 저장소에 이 폴더를 연결하고 지금까지의 커밋을 올린다.
 * 저장소에 README 같은 게 이미 있으면 기록이 따로 시작돼서 푸시가 막히므로, 빈 저장소일 때만 연결한다.
 */
async function connectFlow(git: GitService): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: t("이미 만든 저장소에 연결하기", "Connect a repository you made"),
    prompt: t(
      "GitHub 저장소 페이지 주소를 붙여 넣어요. 초록색 [Code] 버튼에 나오는 주소도 돼요.",
      "Paste the repository page URL. The one from the green [Code] button works too."
    ),
    placeHolder: t("https://github.com/아이디/저장소이름", "https://github.com/user/repo"),
    ignoreFocusOut: true,
    validateInput: checkCloneUrl,
  });
  if (!input) return;
  const url = normalizeCloneUrl(input);
  const page = webUrlFromRemote(url) ?? url;
  const needLogin = t(
    "이 저장소를 찾지 못했어요. 비공개 저장소라면 내 계정으로 로그인해야 연결할 수 있어요.",
    "Couldn't find this repository. If it's private, sign in to connect it."
  );

  let empty: boolean;
  try {
    empty = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("GitHub 저장소 확인하는 중…", "Checking the GitHub repository…") },
      () => withGitHubLogin(url, needLogin, (auth) => git.isRemoteEmpty(url, auth))
    );
  } catch (e: any) {
    const raw = e?.message ?? String(e);
    await showErrorWithRaw(translateGitError(raw), raw);
    return;
  }

  if (!empty) {
    const CREATE = t("새 저장소 만들기로 할게요", "Create a new one instead");
    const pick = await vscode.window.showWarningMessage(
      t("이 저장소에는 이미 파일이 있어서 연결하지 않았어요.", "This repository already has files, so it wasn't connected."),
      {
        modal: true,
        detail: t(
          "GitHub에서 만들 때 README 같은 파일을 넣으면, GitHub 쪽 기록과 내 컴퓨터 기록이 따로 시작돼서 푸시가 막혀요.\n\n" +
            "· GitHub에서 아무 파일도 넣지 않은 빈 저장소를 다시 만들어 연결하거나\n" +
            "· [새 저장소 만들기]로 EasyGit이 빈 저장소를 만들게 해 주세요.\n\n" +
            "이 저장소로 작업하고 싶다면 [GitHub 저장소 가져오기]로 받아서 시작하면 돼요.",
          "If you added files like a README when creating it on GitHub, its history and yours start separately and push gets blocked.\n\n" +
            "· Create an empty repository on GitHub (no files) and connect that, or\n" +
            "· Let EasyGit create an empty one with [Create a new repository].\n\n" +
            "To work on this repository itself, start from [Clone from GitHub]."
        ),
      },
      CREATE
    );
    if (pick === CREATE) return publishFlow(git);
    return;
  }

  const GO = t("연결하고 올리기", "Connect and publish");
  const ok = await vscode.window.showWarningMessage(
    t("이 폴더를 GitHub 저장소에 연결하고 올릴까요?", "Connect this folder to the GitHub repository and publish?"),
    { modal: true, detail: t(`지금까지의 커밋이 ${page} 에 올라가요.`, `Your commits will be uploaded to ${page}.`) },
    GO
  );
  if (ok !== GO) return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("GitHub에 올리는 중…", "Publishing to GitHub…") },
      async () => {
        await git.addRemote(url);
        await withGitHubLogin(url, t("GitHub에 올리려면 내 계정으로 로그인해야 해요.", "Sign in to push to GitHub."), (auth) => git.push(auth));
      }
    );
  } catch (e: any) {
    // 연결까지는 됐을 수 있다. 그러면 윗줄에 푸시 버튼이 생기니 다시 누르면 된다
    EasyGitPanel.current?.scheduleRefresh();
    const raw = e?.message ?? String(e);
    await showErrorWithRaw(translateGitError(raw), raw);
    return;
  }
  EasyGitPanel.current?.scheduleRefresh();
  const VIEW = t("GitHub에서 보기", "View on GitHub");
  const pick = await vscode.window.showInformationMessage(
    t("연결했어요! 다음부터는 푸시만 누르면 돼요. 윗줄 GitHub 옆 ↗ 로 언제든 저장소를 열 수 있어요.", "Connected! From now on, just press Push. Use ↗ next to GitHub at the top to open the repository anytime."),
    VIEW
  );
  if (pick === VIEW) await vscode.env.openExternal(vscode.Uri.parse(page));
}

/** 브랜치 이름을 물어보고 만든다. 만들면 고치던 파일은 그대로 따라온다 */
async function newBranchFlow(git: GitService, from?: string) {
  const state = await git.getState();
  if (!state.isRepo) {
    vscode.window.showWarningMessage(t("이 폴더는 아직 git 저장소가 아니에요.", "This folder isn't a git repository yet."));
    return;
  }
  const taken = new Set(state.branches.map((b) => b.name.replace(/^[^/]+\//, "")));
  const where = from
    ? t(`고른 커밋(${from.slice(0, 7)})에서 갈라져 나온 새 브랜치를 만들어요.`, `Creates a new branch from the selected commit (${from.slice(0, 7)}).`)
    : t(
        `'${state.branch}'에서 갈라져 나온 새 브랜치를 만들어요. 고치던 파일은 그대로 따라와요.`,
        `Creates a new branch from '${state.branch}'. Your uncommitted changes come along.`
      );

  const name = await vscode.window.showInputBox({
    title: t("새 브랜치 만들기", "Create a branch"),
    prompt: where,
    placeHolder: t("예: login-bug-fix", "e.g. login-bug-fix"),
    validateInput: (v) => checkBranchName(v, taken),
  });
  if (!name) return;

  try {
    await git.createBranch(name.trim(), from);
    EasyGitPanel.current?.scheduleRefresh();
  } catch (e: any) {
    vscode.window.showErrorMessage(translateGitError(e?.message ?? String(e)));
  }
}

/** 화면에 바로 보여줄 수 있는 쉬운 말로 브랜치 이름을 검사한다 */
function checkBranchName(raw: string, taken: Set<string>): string | undefined {
  const name = raw.trim();
  if (!name) return t("이름을 적어 주세요.", "Enter a name.");
  if (/\s/.test(name)) return t("빈칸은 쓸 수 없어요. - 나 _ 로 이어 주세요. (예: login-bug-fix)", "No spaces — use - or _ instead (e.g. login-bug-fix)");
  if (/[~^:?*[\\]/.test(name)) return t("~ ^ : ? * [ \\ 는 브랜치 이름에 쓸 수 없어요.", "Branch names can't contain ~ ^ : ? * [ \\");
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return t("- 나 / 로 시작하거나 / 로 끝날 수 없어요.", "Can't start with - or /, or end with /.");
  if (name.includes("..") || name.endsWith(".lock")) return t("이런 이름은 git이 받아주지 않아요.", "Git doesn't allow that name.");
  if (taken.has(name)) return t("이미 있는 브랜치예요. 다른 이름을 적어 주세요.", "That branch already exists. Try another name.");
  return undefined;
}

/** 사이드바에 들어가는 작은 뷰 — 버튼 하나 */
class LauncherView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  constructor(private readonly extensionUri: vscode.Uri) {}
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.render();
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === "open") vscode.commands.executeCommand("easygit.open");
    });
  }

  /** 언어를 바꾸면 다시 그린다 */
  render() {
    if (!this.view) return;
    const nonce = Math.random().toString(36).slice(2);
    this.view.webview.html = `<!DOCTYPE html><html lang="${t("ko", "en")}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
  p { margin: 0 0 12px; opacity: .85; line-height: 1.5; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 4px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 13px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style></head><body>
<p>${t("커밋, 푸시, 브랜치를 한 화면에서 버튼으로.", "Commit, push and branch — all with buttons, on one screen.")}</p>
<button id="open">${t("EasyGit 열기", "Open EasyGit")}</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('open').onclick = () => vscode.postMessage({ type: 'open' });
</script></body></html>`;
  }
}

export function deactivate() {}
