import { useEffect, useRef, useState } from "react";
import type { RepoState, FileChange, Commit, CommitFile } from "../src/gitService";
import { CommitList, MergeView, commitFacts, missingCount, historyOf, mergeSides, type Order } from "./Commits";
import { Settings } from "./Settings";
import { ignoreHints } from "./ignoreHints";
import { Conflicts } from "./Conflicts";
import { Lang, ago, fileLabel, getLang, setLang, t } from "./i18n";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const send = (m: unknown) => vscode.postMessage(m);

type Busy = "commit" | "push" | "pull" | "switch" | "publish" | "undo" | "stash" | null;
type ErrorInfo = { message: string; raw?: string };
type AuthInfo = { account: string | null; skipped: boolean };

export function App() {
  const [state, setState] = useState<RepoState | null>(null);
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  // 어떤 파일을 커밋에 포함할지
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // 커밋 목록에 어느 브랜치의 역사를 보여줄지 — "@main" / "@current" / 고정해 둔 브랜치 이름
  const [view, setView] = useState<string>("@main");
  // 커밋 목록을 최신순으로 볼지 오래된순으로 볼지
  const [order, setOrder] = useState<Order>("new");
  // 합치는 중에는 왼쪽을 "합치는 중" 화면으로. [커밋 목록 보기]로 잠깐 원래 목록을 볼 수 있다
  const [mergeView, setMergeView] = useState(true);
  const [commitFiles, setCommitFiles] = useState<{ hash: string; files: CommitFile[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  // 방금 커밋이 끝났는지 — 커밋 다음에 뭐가 남았는지를 그 자리에서 알려주려고 둔다
  const [justCommitted, setJustCommitted] = useState(false);
  const [skin, setSkin] = useState("vscode");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultPrefixes, setDefaultPrefixes] = useState<string[]>([]);
  const [warnOnMain, setWarnOnMain] = useState(true);
  const [pinned, setPinned] = useState<string[]>([]);
  const [identity, setIdentity] = useState({ name: "", email: "" });
  const [sponsorUrl, setSponsorUrl] = useState<string | null>(null);
  const [ignoreDismissed, setIgnoreDismissed] = useState<string[]>([]);
  // 메시지 처리기는 처음 한 번만 만들어지므로, 최신 값을 ref로 읽는다
  const ignoreDismissedRef = useRef<string[]>([]);
  ignoreDismissedRef.current = ignoreDismissed;
  // t()는 모듈 변수를 읽으니, 언어가 바뀌면 이 상태로 다시 그리게 한다
  const [language, setLanguage] = useState<Lang>(getLang());
  // 커밋이 성공했을 때만 메시지 칸을 비우려고 표시해 둔다 (실패하면 쓴 글이 남아야 하니까)
  const committing = useRef(false);
  const branchBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "state") {
        setState(m.state);
        setError(null);
        setShowRaw(false);
        setBusy(null);
        if (committing.current) {
          committing.current = false;
          setMessage("");
          setJustCommitted(true);
          // 방금 한 커밋이 목록에 쌓이는 게 보이도록, 메인이 아닌 브랜치면 그 브랜치로 바꿔 준다
          if (m.state.branch !== m.state.mainBranch) setView("@current");
        } else {
          setJustCommitted(false);
        }
        // 새로 생긴 파일은 기본 체크. 단 node_modules·.env처럼 보통 안 올리는 것은 빼 둔다
        setChecked((prev) => {
          const files = m.state.files as FileChange[];
          const skip = ignoreHints(files, ignoreDismissedRef.current).paths;
          const next: Record<string, boolean> = {};
          for (const f of files) next[f.path] = prev[f.path] ?? !skip.has(f.path);
          return next;
        });
      } else if (m.type === "config") {
        if (m.language === "ko" || m.language === "en") {
          setLang(m.language);
          setLanguage(m.language);
        }
        setPrefixes(m.commitPrefixes ?? []);
        setSkin(m.skin ?? "vscode");
        setDefaultPrefixes(m.defaultPrefixes ?? []);
        setWarnOnMain(m.warnOnMainBranch ?? true);
        setPinned(m.pinnedBranches ?? []);
        setSponsorUrl(m.sponsorUrl ?? null);
        setIgnoreDismissed(m.ignoreDismissed ?? []);
      } else if (m.type === "identity") {
        setIdentity({ name: m.name, email: m.email });
      } else if (m.type === "commitFiles") {
        setCommitFiles({ hash: m.hash, files: m.files });
      } else if (m.type === "prefill") {
        setMessage(m.message);
      } else if (m.type === "auth") {
        setAuth({ account: m.account, skipped: m.skipped });
      } else if (m.type === "error") {
        committing.current = false;
        setBusy(null);
        setShowRaw(false);
        setError({ message: m.message, raw: m.raw });
      }
    };
    window.addEventListener("message", onMsg);
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 시작 화면·알림까지 전부 같은 스킨이 되도록 문서 맨 위에 붙인다
  useEffect(() => {
    document.documentElement.dataset.skin = skin;
  }, [skin]);

  // 고른 커밋이 사라졌으면(취소했거나 브랜치를 옮김) 오른쪽을 "지금 바뀐 파일"로 돌린다
  useEffect(() => {
    const list = state?.commits ?? [];
    setPicked((prev) => (prev && list.some((c) => c.hash === prev) ? prev : null));
  }, [state]);

  useEffect(() => {
    if (picked) send({ type: "commitFiles", hash: picked });
  }, [picked]);

  const merging = !!state?.merge;
  useEffect(() => {
    if (!merging) return;
    setMergeView(true);
    // 합치기는 지금 브랜치에서 일어나니, [커밋 목록 보기]를 눌렀을 때 그 브랜치가 보이게 맞춰 둔다
    setView("@current");
  }, [merging]);

  // 브랜치 목록 바깥을 누르거나 Esc를 누르면 닫기
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!branchBox.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (!state && error)
    return (
      <Notice tone="error">
        {t("git 정보를 읽지 못했어요.", "Couldn't read git information.")} {error.message}
      </Notice>
    );
  if (!state) return <Notice>{t("불러오는 중…", "Loading…")}</Notice>;
  // 로그인 안내는 로그인 안 했고 "나중에"도 안 눌렀을 때만. 확인 전(auth=null)엔 깜빡이지 않게 숨긴다
  const showLoginBanner = !!auth && !auth.account && !auth.skipped;
  if (!state.isRepo)
    return (
      <div className="start-wrap" key={language}>
        {showLoginBanner && <LoginBanner />}
        <StartScreen folder={state.folder} error={error} />
      </div>
    );

  const checkedPaths = state.files.filter((f) => checked[f.path]).map((f) => f.path);
  const checkedCount = checkedPaths.length;
  const canCommit = busy === null && checkedCount > 0 && message.trim() !== "";
  // 새 동작을 시작했으면 지난 에러보다 "지금 하는 중"을 보여준다
  const guide: Guide = busy
    ? { tone: "info", text: busyText(busy) }
    : error
      ? { tone: "error", text: error.message }
      : buildGuide(state, checkedCount, message);

  const branchName = state.branch || t("(브랜치 없음)", "(no branch)");
  const locals = state.branches.filter((b) => !b.remote);
  const localNames = new Set(locals.map((b) => b.name));
  const remoteOnly = state.branches.filter((b) => b.remote && !localNames.has(shortName(b.name)));
  const selected = state.commits.find((c) => c.hash === picked) ?? null;
  const facts = commitFacts(state.commits, state.branches, state.branch);
  const viewBranch = view === "@main" ? state.mainBranch : view === "@current" ? state.branch : view;
  const viewKind = view === "@main" ? "main" : view === "@current" ? "current" : "pinned";
  // 고정해 둔 브랜치 중 지금 실제로 있는 것만. 메인·현재는 이미 버튼이 있으니 뺀다
  const pinnedNow = pinned.filter((b) => b !== state.mainBranch && b !== state.branch && locals.some((l) => l.name === b));
  const history = historyOf(state.commits, state.branches, viewBranch, state.mainBranch, facts);
  // 다른 브랜치를 볼 때만 목록 위에 'GitHub에 새 커밋' 띠를 띄운다. 지금 브랜치면 윗줄 풀 버튼이 이미 알려준다
  const onCurrentBranch = viewBranch === state.branch;
  const allChecked = state.files.length > 0 && checkedCount === state.files.length;
  const issue = state.branch.match(/(?:^|[/_-])(\d{1,6})(?:[/_-]|$)/)?.[1];

  const switchTo = (name: string, remote: boolean) => {
    setMenuOpen(false);
    setBusy("switch");
    send({ type: "switchBranch", name, remote });
  };

  /** 내 컴퓨터에 없는 브랜치면 GitHub에서 가져오면서 옮긴다 */
  const moveTo = (name: string) => {
    const hasLocal = state.branches.some((b) => !b.remote && b.name === name);
    switchTo(hasLocal ? name : `origin/${name}`, !hasLocal);
    setView("@current");
    setPicked(null);
  };

  const doCommit = () => {
    if (!canCommit) return;
    committing.current = true;
    setBusy("commit");
    send({ type: "commit", paths: checkedPaths, message: message.trim() });
  };

  const doPush = () => {
    setBusy("push");
    send({ type: "push" });
  };

  const doPull = () => {
    setBusy("pull");
    send({ type: "pull" });
  };

  const doPublish = () => {
    setBusy("publish");
    send({ type: "publish" });
  };

  /** 하단 안내줄의 버튼이 누르는 것들 — 안내 문장과 버튼이 늘 같은 것을 가리키게 한다 */
  const guideActions: Record<GuideKind, () => void> = {
    push: doPush,
    pull: doPull,
    publish: doPublish,
    selectAll: () => setChecked(Object.fromEntries(state.files.map((f) => [f.path, true]))),
    popStash: () => {
      setBusy("stash");
      send({ type: "popStash" });
    },
    openPR: () => send({ type: "openPullRequest" }),
  };
  const ignore = ignoreHints(state.files, ignoreDismissed);

  const addPrefix = (prefix: string) => {
    const bare = prefixes.reduce((m, p) => (m.startsWith(p) ? m.slice(p.length) : m), message);
    setMessage(prefix + bare);
  };

  const addIssue = () => {
    const tag = `(#${issue})`;
    if (message.includes(tag)) return;
    setMessage(message.trim() ? `${message.trim()} ${tag}` : tag);
  };

  return (
    <div className="app">
      <div className="top">
        {showLoginBanner && <LoginBanner />}
        <header className="topbar">
          <div className="zone local">
            <span className="zone-label">{t("내 컴퓨터", "Your computer")}</span>
            <div className="views" ref={branchBox}>
              <div className="view-scroll">
            <button
              className={`view ${viewKind === "main" ? "on" : ""}`}
              onClick={() => setView("@main")}
              title={t("팀 모두가 기준으로 쓰는 브랜치의 역사를 보여줘요", "Show the history of the branch your team builds on")}
            >
              {t("메인 브랜치", "Main branch")} <span className="view-name">{state.mainBranch}</span>
            </button>
            <div className={`view split ${viewKind === "current" ? "on" : ""}`}>
              <button
                className="view-main"
                onClick={() => setView("@current")}
                title={t("지금 작업 중인 브랜치의 역사를 보여줘요", "Show the history of the branch you're working on")}
              >
                {t("현재 브랜치", "Current branch")} <span className="view-name">{branchName}</span>
              </button>
              <button
                className="view-caret"
                disabled={busy !== null || !!state.merge}
                onClick={() => setMenuOpen((v) => !v)}
                title={t("다른 브랜치로 옮기기 / 새 브랜치 만들기", "Switch branch / create a branch")}
                aria-label={t("브랜치 목록 열기", "Open branch list")}
              >
                ▾
              </button>
            </div>
            {pinnedNow.map((b) => (
              <button
                key={b}
                className={`view pinned ${view === b ? "on" : ""}`}
                onClick={() => setView(b)}
                title={t(
                  `설정에서 고정해 둔 브랜치예요. '${b}'의 커밋 목록을 보여줘요 (브랜치를 옮기지는 않아요)`,
                  `Pinned in Settings. Shows the commits on '${b}' (it doesn't switch branches)`
                )}
              >
                <span className="view-name">{b}</span>
              </button>
            ))}
              </div>
            {menuOpen && (
              <div className="menu">
                <button
                  className="menu-item new"
                  onClick={() => {
                    setMenuOpen(false);
                    send({ type: "newBranch" });
                  }}
                >
                  <span className="tick">+</span>
                  <span className="menu-name">{t("새 브랜치 만들기", "Create a branch")}</span>
                </button>
                <div className="menu-section">{t("내 브랜치", "My branches")}</div>
                {locals.map((b) => (
                  <div key={b.name} className="menu-row">
                    <button className="menu-item" disabled={b.current} onClick={() => switchTo(b.name, false)}>
                      <span className="tick">{b.current ? "✓" : ""}</span>
                      <span className="menu-name">{b.name}</span>
                      {b.current && <span className="menu-hint">{t("지금 여기", "current")}</span>}
                    </button>
                    {/* 지금 있는 브랜치와 메인은 지울 수 없게 버튼을 아예 안 단다 */}
                    {!b.current && b.name !== state.mainBranch && (
                      <button
                        className="menu-del"
                        disabled={busy !== null}
                        title={t("이 브랜치 삭제 (내 컴퓨터에서만)", "Delete this branch (on your computer only)")}
                        aria-label={t(`'${b.name}' 브랜치 삭제`, `Delete branch '${b.name}'`)}
                        onClick={() => {
                          setMenuOpen(false);
                          send({ type: "deleteBranch", name: b.name });
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                {remoteOnly.length > 0 && <div className="menu-section">{t("GitHub에만 있는 브랜치", "Only on GitHub")}</div>}
                {remoteOnly.map((b) => (
                  <button key={b.name} className="menu-item" onClick={() => switchTo(b.name, true)}>
                    <span className="tick" />
                    <span className="menu-name">{shortName(b.name)}</span>
                    <span className="menu-hint">{t("가져오기", "check out")}</span>
                  </button>
                ))}
              </div>
            )}
            </div>
          </div>
          <div className="topbar-right">
          <div className="zone remote">
            <span className="zone-label">
              GitHub
              {state.repoPageUrl && (
                <button
                  className="repo-link"
                  title={t(`GitHub에서 저장소 열기\n${state.repoPageUrl}`, `Open repository on GitHub\n${state.repoPageUrl}`)}
                  aria-label={t("GitHub에서 저장소 열기", "Open repository on GitHub")}
                  onClick={() => send({ type: "openRepoPage" })}
                >
                  ↗
                </button>
              )}
            </span>
            <div className="sync">
            {state.hasRemote ? (
              <>
                <button
                  className="ghost"
                  disabled={busy !== null || !!state.merge}
                  title={t("GitHub에 있는 새 커밋을 내 컴퓨터로 가져와요", "Bring new commits from GitHub to your computer")}
                  onClick={doPull}
                >
                  <span className="sync-word">
                    {t("풀", "Pull")} ↓{state.behind > 0 && <b>{state.behind}</b>}
                  </span>
                </button>
                <button
                  className="ghost"
                  disabled={busy !== null || !!state.merge}
                  title={t("내 커밋을 GitHub에 올려요", "Upload your commits to GitHub")}
                  onClick={doPush}
                >
                  <span className="sync-word">
                    {t("푸시", "Push")} ↑{state.ahead > 0 && <b>{state.ahead}</b>}
                  </span>
                </button>
              </>
            ) : (
              // GitHub에 아직 없는 저장소는 풀/푸시 대신 "올리기" 하나만 보여준다
              <button
                className="ghost"
                disabled={busy !== null || state.commits.length === 0}
                title={
                  state.commits.length === 0
                    ? t("먼저 첫 커밋을 해 주세요", "Make your first commit first")
                    : t(
                        "GitHub에 저장소를 새로 만들거나, 이미 만들어 둔 저장소에 연결해서 지금까지의 커밋을 올려요",
                        "Create a GitHub repository, or connect one you already made, and upload your commits"
                      )
                }
                onClick={doPublish}
              >
                <span className="sync-word">{t("GitHub에 올리기", "Publish to GitHub")} ↑</span>
              </button>
            )}
            </div>
          </div>
          <div className="tools">
            <button
              className={`icon-btn ${spinning ? "spinning" : ""}`}
              onClick={() => {
                // 눌렀다는 게 눈에 보이도록 한 바퀴 돌린다 (다시 읽기는 금방 끝나서 변화가 안 보일 때가 많다)
                setSpinning(true);
                setTimeout(() => setSpinning(false), 600);
                send({ type: "refresh" });
              }}
              title={t("다시 읽기", "Refresh")}
              aria-label={t("다시 읽기", "Refresh")}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                <path d="M20 4v7h-7" />
              </svg>
            </button>
            <button
              className={`icon-btn ${settingsOpen ? "on" : ""}`}
              onClick={() => setSettingsOpen(true)}
              title={t("설정 — 계정, 언어, 스킨, 말머리", "Settings — account, language, skin, prefixes")}
              aria-label={t("설정 열기", "Open settings")}
              data-testid="open-settings"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
            {auth?.account ? (
              <span className="account" title={t("로그인한 GitHub 계정", "Signed-in GitHub account")}>
                <span className="account-dot" />
                {auth.account}
              </span>
            ) : (
              auth?.skipped && (
                <button className="link" onClick={() => send({ type: "login" })}>
                  {t("GitHub 로그인", "Sign in to GitHub")}
                </button>
              )
            )}
            </div>
          </div>
        </header>
      </div>

      <main className="body">
        <section className="history">
          <h2>
            {state.merge && mergeView ? t("합치는 중", "Merging") : t("커밋 목록", "Commits")}
            <span className="count">{state.merge && mergeView ? state.branch : viewBranch}</span>
            {state.merge ? (
              <button
                className="chip order"
                onClick={() => setMergeView((v) => !v)}
                title={t("합치는 중 화면과 원래 커밋 목록을 오가요", "Switch between the merge view and the usual commit list")}
              >
                {mergeView ? t("커밋 목록 보기", "Show commit list") : t("← 합치는 중으로", "← Back to merging")}
              </button>
            ) : (
              <button
                className="chip order"
                onClick={() => setOrder((o) => (o === "new" ? "old" : "new"))}
                title={t("누르면 순서가 바뀌어요", "Click to flip the order")}
              >
                {order === "new" ? t("최신순 ↓", "Newest first ↓") : t("오래된순 ↑", "Oldest first ↑")}
              </button>
            )}
          </h2>
          {state.merge && mergeView ? (
            <MergeView
              sides={mergeSides(state.commits, state.merge)}
              from={state.merge.fromRemote ? t(`GitHub의 ${state.merge.from}`, `${state.merge.from} on GitHub`) : state.merge.from}
              clash={state.merge.conflicts.length}
              base={!!state.merge.base}
            />
          ) : (
          <>
          {(() => {
            const behind = history.items.filter((it) => it.stage === "remote").length;
            // 합치는 중이면 그 커밋들이 바로 지금 받고 있는 것이라 안내하지 않는다.
            // 지금 브랜치를 보고 있으면 목록 안의 구분줄이 같은 말을 하니 여기서는 생략한다.
            if (behind === 0 || state.merge || onCurrentBranch) return null;
            return (
              <div
                className="behind-note"
                title={t("점선 커밋은 GitHub에만 있어요. 풀을 하면 내 컴퓨터로 들어와요.", "Dashed commits are only on GitHub. Pull to bring them in.")}
              >
                <p>
                  {t("GitHub에 새 커밋 ", "New on GitHub: ")}
                  <b>{t(`${behind}개`, `${behind}`)}</b>
                </p>
                <button
                  className="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy("pull");
                    send({ type: "pullBranch", name: viewBranch });
                  }}
                >
                  {t(`${viewBranch}(으)로 옮겨서 풀 ↓`, `Switch to ${viewBranch} & pull ↓`)}
                </button>
              </div>
            );
          })()}
          {(() => {
            // PR을 올린 사이 main이 앞서 나갔으면, 내 브랜치로 받아오는 길을 알려준다
            if (viewKind !== "current" || state.branch === state.mainBranch || state.merge) return null;
            const n = missingCount(state.commits, state.mainBranch, state.branch);
            if (n === 0) return null;
            return (
              <div
                className="behind-note main"
                title={t(
                  `${state.mainBranch}에 합쳐졌지만 이 브랜치엔 없는 커밋이에요. 받아오면 PR에서 충돌하는 걸 미리 풀 수 있어요.`,
                  `Commits merged into ${state.mainBranch} that this branch doesn't have. Bringing them in lets you fix PR conflicts early.`
                )}
              >
                <p>
                  {t(`${state.mainBranch}에 새 커밋 `, `New on ${state.mainBranch}: `)}
                  <b>{t(`${n}개`, `${n}`)}</b>
                </p>
                <button
                  className="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy("pull");
                    send({ type: "updateFromMain" });
                  }}
                >
                  {t(`${state.mainBranch} 최신 내용 받아오기 ↓`, `Update from ${state.mainBranch} ↓`)}
                </button>
              </div>
            );
          })()}
          <CommitList
            history={history}
            order={order}
            view={viewBranch}
            main={state.mainBranch}
            selected={picked}
            onSelect={(h) => setPicked(h === picked ? null : h)}
            pending={viewBranch === state.branch ? state.files.length : 0}
            clash={viewBranch === state.branch ? state.merge?.conflicts.length ?? 0 : 0}
            onPending={() => setPicked(null)}
            busy={busy !== null || !!state.merge}
            onJump={moveTo}
          />
          </>
          )}
        </section>

        <section className={`work ${state.merge ? "mode-clash" : selected ? "mode-after" : "mode-before"}`}>
          {state.merge ? (
            <Conflicts merge={state.merge} files={state.files} busy={busy !== null} send={send} />
          ) : selected ? (
            <>
              <h2>
                <button className="link back" onClick={() => setPicked(null)}>
                  {t("← 돌아가기", "← Back to uncommitted files")}
                </button>
              </h2>
              <CommitDetail
                commit={selected}
                state={state}
                facts={facts}
                busy={busy !== null}
                onUndo={() => {
                  setBusy("undo");
                  send({ type: "undoCommit", hash: selected.hash });
                }}
                onRevert={() => {
                  setBusy("undo");
                  send({ type: "revertCommit", hash: selected.hash });
                }}
                onSwitch={(name) => switchTo(name, false)}
              />
              <h2 className="sub">
                <span className="mode-tag after">{t("커밋 후", "Committed")}</span>
                {t("이 커밋에 담긴 파일", "Files in this commit")}
                <span className="count">{commitFiles?.hash === selected.hash ? commitFiles.files.length : ""}</span>
                {commitFiles?.hash === selected.hash && <DiffStat files={commitFiles.files} total />}
              </h2>
              {commitFiles?.hash !== selected.hash ? (
                <div className="files-empty">{t("불러오는 중…", "Loading…")}</div>
              ) : commitFiles.files.length === 0 ? (
                <div className="files-empty">{t("파일을 바꾸지 않은 커밋이에요.", "This commit didn't change any files.")}</div>
              ) : (
                <ul className="files readonly committed">
                  {commitFiles.files.map((f) => (
                    <li key={f.path}>
                      <button
                        className="path"
                        onClick={() => send({ type: "openCommitDiff", hash: selected.hash, path: f.path, oldPath: f.oldPath })}
                        title={`${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}\n${t("누르면 바뀐 줄을 보여줘요", "Click to see the changed lines")}`}
                      >
                        <span className="dir">{dirOf(f.path)}</span>
                        <span className="name">{nameOf(f.path)}</span>
                      </button>
                      <DiffStat files={[f]} />
                      <span className={`status s-${f.label}`}>{fileLabel(f.label)}</span>
                      {/* 이름이 바뀐 파일은 원래 이름까지 같이 돌려야 해서 여기서는 버리지 않는다 */}
                      {f.label === "conflict" || f.label === "renamed" || f.label === "copied" ? (
                        <span />
                      ) : (
                        <button
                          className="discard"
                          disabled={busy !== null}
                          title={t("이 파일 변경 버리기 (마지막 커밋 상태로)", "Discard changes to this file (back to last commit)")}
                          aria-label={t("변경 버리기", "Discard changes")}
                          onClick={() => send({ type: "discardFile", path: f.path })}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
                          </svg>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <h2>
                <span className="mode-tag before">{t("커밋 전", "Uncommitted")}</span>
                {t("아직 커밋 안 한 파일", "Changes not committed")} <span className="count">{state.files.length}</span>
                {state.files.length > 0 && <DiffStat files={state.files} total />}
                {state.files.length > 0 && (
                  <label className="select-all">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = checkedCount > 0 && !allChecked;
                      }}
                      onChange={() => setChecked(Object.fromEntries(state.files.map((f) => [f.path, !allChecked])))}
                    />
                    {t("전체 선택", "Select all")}
                  </label>
                )}
              </h2>

              {ignore.hints.length > 0 && (
                <div className={`ignore-hint ${ignore.hints.some((h) => h.secret) ? "secret" : ""}`}>
                  <p>
                    {t("보통 GitHub에 안 올리는 파일이 있어요: ", "These usually stay off GitHub: ")}
                    <code>{ignore.hints.map((h) => h.pattern).join(", ")}</code>
                    {ignore.hints.some((h) => h.secret) &&
                      t(" — .env에는 비밀번호·키가 들어 있을 수 있어요.", " — .env files can hold passwords and keys.")}
                  </p>
                  <div className="ignore-actions">
                    <button
                      className="primary small"
                      disabled={busy !== null}
                      title={t(".gitignore 파일에 적어서 앞으로 이 목록에 안 나오게 해요", "Adds them to .gitignore so they stop showing up here")}
                      onClick={() => send({ type: "ignoreFiles", patterns: ignore.hints.map((h) => h.pattern) })}
                    >
                      {t("올리지 않기", "Keep off GitHub")}
                    </button>
                    <button className="link" onClick={() => send({ type: "dismissIgnoreHint", patterns: ignore.hints.map((h) => h.pattern) })}>
                      {t("그냥 둘래요", "Leave them")}
                    </button>
                  </div>
                </div>
              )}

              {state.files.length === 0 ? (
                <div className={`files-empty ${justCommitted ? "done" : ""}`}>
                  {justCommitted ? (
                    <p>
                      <strong>{t("커밋했어요 ✓", "Committed ✓")}</strong>
                      <br />
                      {!state.hasRemote
                        ? t("아직 내 컴퓨터에만 있어요.", "It's still only on your computer.")
                        : state.ahead > 0
                          ? t(
                              `아직 GitHub에 안 올린 커밋이 ${state.ahead}개 쌓였어요. 푸시 한 번에 같이 올라가요.`,
                              `${state.ahead} commit(s) are waiting for GitHub. One push sends them all.`
                            )
                          : t("GitHub에도 올라가 있어요.", "It's on GitHub too.")}
                    </p>
                  ) : (
                    t("바뀐 파일이 없어요. 파일을 고치고 저장하면 여기에 나타나요.", "No changes. Edit and save a file and it shows up here.")
                  )}
                </div>
              ) : (
                <ul className="files uncommitted">
                  {state.files.map((f) => (
                    <li key={f.path} className={f.label === "conflict" ? "conflict" : ""}>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={checked[f.path] ?? true}
                          onChange={(e) => setChecked({ ...checked, [f.path]: e.target.checked })}
                        />
                      </label>
                      <button
                        className="path"
                        onClick={() => send({ type: f.label === "added" ? "openFile" : "openDiff", path: f.path })}
                        title={`${f.path}\n${t("누르면 바뀐 줄을 보여줘요", "Click to see the changed lines")}`}
                      >
                        <span className="dir">{dirOf(f.path)}</span>
                        <span className="name">{nameOf(f.path)}</span>
                      </button>
                      <DiffStat files={[f]} />
                      <span className={`status s-${f.label}`}>{fileLabel(f.label)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="commit">
                <label htmlFor="msg">{t("무엇을 바꿨나요?", "What did you change?")}</label>
                <textarea
                  id="msg"
                  rows={3}
                  placeholder={t("예: 로그인 버그 고침", "e.g. Fix login bug")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="commit-actions">
                  {prefixes.length > 0 && (
                    <select
                      className="prefix"
                      value=""
                      title={t("커밋 메시지 앞에 붙일 말머리 (설정에서 바꿀 수 있어요)", "Add a prefix to the message (change the list in Settings)")}
                      onChange={(e) => e.target.value && addPrefix(e.target.value)}
                    >
                      <option value="">{t("말머리 붙이기", "Add prefix")}</option>
                      {prefixes.map((p) => (
                        <option key={p} value={p}>
                          {p.trim()}
                        </option>
                      ))}
                    </select>
                  )}
                  {issue && (
                    <button className="chip" onClick={addIssue} title={t("브랜치 이름에서 찾은 번호예요", "Number found in the branch name")}>
                      {t(`#${issue} 넣기`, `Add #${issue}`)}
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="primary" disabled={!canCommit} onClick={doCommit}>
                    {busy === "commit"
                      ? t("커밋하는 중…", "Committing…")
                      : checkedCount > 0
                        ? t(`커밋 (${checkedCount}개 파일)`, `Commit (${checkedCount} file${checkedCount === 1 ? "" : "s"})`)
                        : t("커밋", "Commit")}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </main>

      {settingsOpen && (
        <Settings
          data={{
            account: auth?.account ?? null,
            identity,
            skin,
            prefixes,
            defaultPrefixes,
            warnOnMainBranch: warnOnMain,
            branches: locals.map((b) => b.name),
            pinned,
            sponsorUrl,
            language,
          }}
          send={send}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <footer className={`guide ${guide.tone}`}>
        <div className="guide-row">
          <span className="guide-dot" />
          <p>{guide.text}</p>
          {error?.raw && !busy && (
            <button className="link" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t("원문 닫기", "Hide details") : t("원문 보기", "Show details")}
            </button>
          )}
          {guide.action && (
            <button className="primary small guide-do" disabled={busy !== null} onClick={guideActions[guide.action.kind]}>
              {guide.action.label}
            </button>
          )}
        </div>
        {error?.raw && showRaw && !busy && <pre className="raw">{error.raw}</pre>}
      </footer>
    </div>
  );
}

/** 그래프에서 고른 커밋 — 누가/언제/무엇 + 이 커밋으로 할 수 있는 일 딱 하나 */
function CommitDetail({
  commit,
  state,
  facts,
  busy,
  onUndo,
  onRevert,
  onSwitch,
}: {
  commit: Commit;
  state: RepoState;
  facts: ReturnType<typeof commitFacts>;
  busy: boolean;
  onUndo: () => void;
  onRevert: () => void;
  onSwitch: (branch: string) => void;
}) {
  const onCurrent = facts.isOnCurrent(commit.hash);
  const pushed = facts.isPushed(commit.hash);
  const home = onCurrent ? state.branch : facts.localBranchesWith(commit.hash)[0];
  const status = !state.hasRemote
    ? t("내 컴퓨터에만 있는 커밋", "Only on your computer")
    : pushed
      ? t("GitHub에 올라간 커밋", "On GitHub")
      : t("아직 GitHub에 안 올린 커밋", "Not pushed to GitHub yet");

  let action: React.ReactNode;
  if (!onCurrent) {
    action = home ? (
      <div className="detail-actions">
        <button className="ghost" disabled={busy} onClick={() => onSwitch(home)}>
          {t(`'${home}'(으)로 옮기기`, `Switch to '${home}'`)}
        </button>
        <Hint
          text={t(
            `'${home}' 브랜치의 커밋이에요. 취소하거나 되돌리려면 그 브랜치로 먼저 옮겨야 해요.`,
            `This commit is on '${home}'. Switch to that branch to undo or revert it.`
          )}
        />
      </div>
    ) : (
      <p className="detail-hint">
        {t(
          "GitHub에만 있고 아직 내 컴퓨터엔 없는 커밋이에요. 그 브랜치에서 풀을 하면 들어와요.",
          "This commit is only on GitHub. Pull on its branch to get it."
        )}
      </p>
    );
  } else if (commit.parents.length === 0) {
    action = (
      <p className="detail-hint">{t("저장소의 맨 첫 커밋이라 취소할 수 없어요.", "This is the repository's first commit, so it can't be undone.")}</p>
    );
  } else if (!pushed) {
    action = (
      <div className="detail-actions">
        <button className="primary small" disabled={busy} onClick={onUndo}>
          {t("이 커밋 취소하기", "Undo this commit")}
        </button>
        <Hint
          text={t(
            `'${state.branch}' 브랜치가 이 커밋 전으로 돌아가요. 커밋했던 내용은 지워지지 않고 '바뀐 파일'로 돌아와서, 다른 브랜치로 옮겨 다시 커밋할 수 있어요.`,
            `'${state.branch}' goes back to before this commit. Nothing is lost — the changes come back as uncommitted files, so you can move them to another branch and commit again.`
          )}
        />
      </div>
    );
  } else {
    action = (
      <div className="detail-actions">
        <button className="ghost" disabled={busy} onClick={onRevert}>
          {t("이 커밋 취소", "Create a revert commit")}
        </button>
        <Hint
          text={t(
            "이미 GitHub에 올라간 커밋은 지우면 팀원 기록과 어긋나요. 대신 이 커밋이 바꾼 내용을 반대로 되돌리는 커밋을 새로 만들어요.",
            "Erasing a commit that's already on GitHub would break your teammates' history. Instead, a new commit that undoes its changes is created."
          )}
        />
      </div>
    );
  }

  return (
    <div className="detail">
      <p className="detail-subject">{commit.subject}</p>
      <p className="dim">
        {commit.author} · {ago(commit.date)} · <span className={pushed ? "" : "unpushed"}>{status}</span>
      </p>
      {action}
      <button className="link detail-more" disabled={busy} onClick={() => send({ type: "newBranch", from: commit.hash })}>
        {t("이 커밋에서 새 브랜치 만들기", "Create a branch from this commit")}
      </button>
    </div>
  );
}

/**
 * 버튼 옆 ⓘ — 마우스를 올리거나 탭으로 옮겨오면 "왜 그런지"가 뜬다.
 * 설명을 늘 펼쳐 두면 버튼보다 글이 더 길어져서, 필요한 사람만 보게 접어 둔 것이다.
 */
function Hint({ text }: { text: string }) {
  return (
    <span className="hint" tabIndex={0} role="note" aria-label={text} data-tip={text}>
      i
    </span>
  );
}

/**
 * 늘어난 줄 / 줄어든 줄. 파일을 열어보기 전에 "얼마나 바뀌었는지"가 보이게.
 * total이면 여러 파일을 합친 값을 보여준다.
 */
function DiffStat({
  files,
  total,
}: {
  files: { added?: number; deleted?: number; binary?: boolean }[];
  total?: boolean;
}) {
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  if (!total && files[0]?.binary) return <span className="diffstat dim">{t("파일", "binary")}</span>;
  if (!total && files[0]?.added === undefined) return <span className="diffstat" />;
  const sum = added + deleted;
  // GitHub처럼 다섯 칸: 늘어난 비율만큼 초록, 줄어든 비율만큼 빨강
  const green = sum === 0 ? 0 : Math.round((added / sum) * 5);
  const red = sum === 0 ? 0 : 5 - green;
  return (
    <span
      className={`diffstat ${total ? "total" : ""}`}
      title={t(`${added}줄 늘고 ${deleted}줄 줄었어요`, `${added} line(s) added, ${deleted} removed`)}
    >
      <span className="plus">+{added}</span>
      <span className="minus">−{deleted}</span>
      {!total && (
        <span className="blocks" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <i key={i} className={i < green ? "g" : i < green + red ? "r" : ""} />
          ))}
        </span>
      )}
    </span>
  );
}

function LoginBanner() {
  return (
    <div className="login-banner">
      <p>
        <strong>{t("GitHub에 로그인해 둘까요?", "Sign in to GitHub now?")}</strong>
        <span className="dim">
          {t(
            " 저장소 가져오기·올리기를 할 때 막힘 없이 바로 돼요. 나중에 필요할 때 해도 괜찮아요.",
            " Cloning and publishing will just work. You can also do it later when needed."
          )}
        </span>
      </p>
      <div className="login-actions">
        <button className="primary small" onClick={() => send({ type: "login" })}>
          {t("GitHub 로그인", "Sign in to GitHub")}
        </button>
        <button className="link" onClick={() => send({ type: "skipLogin" })}>
          {t("나중에 할게요", "Maybe later")}
        </button>
      </div>
    </div>
  );
}

function StartScreen({ folder, error }: { folder: string; error: ErrorInfo | null }) {
  return (
    <div className="start">
      <h1>{t("이 폴더는 아직 git 저장소가 아니에요", "This folder isn't a git repository yet")}</h1>
      <p className="dim">{t("어떻게 시작할지 골라 주세요.", "How would you like to start?")}</p>
      <div className="start-options">
        <button className="start-card" onClick={() => send({ type: "init" })}>
          <strong>{t("이 폴더를 저장소로 만들기", "Turn this folder into a repository")}</strong>
          <span>{t("처음 시작하는 내 프로젝트라면 이쪽이에요.", "For a new project of your own.")}</span>
          <span className="dim">
            {t(`'${folder}' 폴더에서 변경 기록을 시작해요. 파일은 그대로예요.`, `Starts tracking changes in '${folder}'. Your files stay as they are.`)}
          </span>
        </button>
        <button className="start-card" onClick={() => send({ type: "clone" })}>
          <strong>{t("GitHub 저장소 가져오기", "Clone from GitHub")}</strong>
          <span>{t("팀 프로젝트라면 이쪽이에요.", "For a team project.")}</span>
          <span className="dim">
            {t("GitHub에 있는 저장소를 내 컴퓨터로 복사해 와요. 새 폴더가 생겨요.", "Copies a GitHub repository to your computer in a new folder.")}
          </span>
        </button>
      </div>
      {error && <p className="start-error">{error.message}</p>}
    </div>
  );
}

function busyText(busy: Exclude<Busy, null>): string {
  switch (busy) {
    case "commit":
      return t("커밋하는 중이에요…", "Committing…");
    case "push":
      return t("GitHub에 올리는 중이에요…", "Pushing to GitHub…");
    case "pull":
      return t("GitHub에서 받아오는 중이에요…", "Pulling from GitHub…");
    case "switch":
      return t("브랜치를 옮기는 중이에요…", "Switching branch…");
    case "publish":
      return t("GitHub에 올리는 중이에요…", "Publishing to GitHub…");
    case "undo":
      return t("커밋을 되돌리는 중이에요…", "Undoing commit…");
    case "stash":
      return t("치워둔 변경을 꺼내는 중이에요…", "Restoring stashed changes…");
  }
}

/** 하단 안내줄이 시키는 일. 안내 문장 옆에 같은 뜻의 버튼 하나가 붙는다 */
type GuideKind = "push" | "pull" | "publish" | "selectAll" | "popStash" | "openPR";
type Guide = { text: string; tone: string; action?: { kind: GuideKind; label: string } };

/**
 * 하단 안내 — "지금 뭘 해야 하는지" 한 줄 + 그걸 바로 하는 버튼 하나.
 * 문장만 있으면 버튼을 찾으러 화면을 훑어야 해서, 말과 버튼을 늘 한 자리에 둔다.
 */
function buildGuide(s: RepoState, checkedCount: number, message: string): Guide {
  if (s.merge && s.merge.conflicts.length > 0)
    return {
      tone: "warn",
      text: t(
        `충돌한 파일 ${s.merge.conflicts.length}개. 오른쪽에서 파일마다 내 거 / 팀원 거를 골라 주세요.`,
        `${s.merge.conflicts.length} conflicting file(s). On the right, choose mine or theirs for each.`
      ),
    };
  if (s.merge)
    return { tone: "ready", text: t("다 골랐어요. [합치기 마무리]를 누르면 합친 커밋이 만들어져요.", "All set. Press [Finish merge] to create the merge commit.") };
  if (s.files.length > 0 && checkedCount === 0)
    return {
      tone: "info",
      text: t("커밋에 넣을 파일을 하나 이상 체크해 주세요.", "Check at least one file to commit."),
      action: { kind: "selectAll", label: t("전체 선택", "Select all") },
    };
  const firstCommit = s.commits.length === 0;
  if (s.files.length > 0 && message.trim() === "")
    return firstCommit
      ? {
          tone: "info",
          text: t(
            "첫 커밋을 해 볼 차례예요. 무엇을 담았는지 적고 커밋을 눌러요. (예: 프로젝트 시작)",
            'Time for your first commit. Describe it and press Commit. (e.g. "Start project")'
          ),
        }
      : {
          tone: "info",
          text: t(
            `커밋 안 한 변경 ${s.files.length}개. 무엇을 바꿨는지 적고 커밋을 누르면 돼요.`,
            `${s.files.length} uncommitted change(s). Describe what you changed and press Commit.`
          ),
        };
  if (s.files.length > 0)
    return {
      tone: "ready",
      // 커밋 버튼은 바로 위 커밋 칸에 있다. 여기까지 버튼을 두면 같은 버튼이 위아래로 둘이 된다
      text: t("좋아요. 커밋을 누르면 지금까지 한 작업이 기록으로 남아요.", "Looks good. Press Commit to save your work."),
    };
  if (firstCommit)
    return {
      tone: "info",
      text: t("저장소가 준비됐어요. 파일을 만들거나 고치고 저장하면 여기에 나타나요.", "Your repository is ready. Create or edit a file and save it."),
    };
  // 브랜치를 옮기며 치워둔 작업은 돌아오자마자 알려야 "작업이 사라졌다"고 오해하지 않는다
  if (s.stashes.some((x) => x.branch === s.branch))
    return {
      tone: "info",
      text: t(
        `'${s.branch}'에서 잠시 치워둔 변경이 있어요. 다시 꺼내면 이어서 작업할 수 있어요.`,
        `You stashed changes on '${s.branch}'. Restore them to keep working.`
      ),
      action: { kind: "popStash", label: t("다시 꺼내기", "Restore") },
    };
  if (!s.hasRemote)
    return {
      tone: "ready",
      text: t(
        "커밋이 내 컴퓨터에 기록됐어요. GitHub에 올리면 새 저장소가 만들어져요.",
        "Your commits are saved on your computer. Publishing creates a GitHub repository."
      ),
      action: { kind: "publish", label: t("GitHub에 올리기 ↑", "Publish to GitHub ↑") },
    };
  if (s.behind > 0 && s.ahead > 0)
    return {
      tone: "warn",
      text: t(
        `GitHub에 새 커밋 ${s.behind}개, 내 커밋 ${s.ahead}개. 먼저 풀을 하고 나서 푸시해요.`,
        `${s.behind} new commit(s) on GitHub and ${s.ahead} of yours. Pull first, then push.`
      ),
      action: { kind: "pull", label: t(`풀 ↓ ${s.behind}`, `Pull ↓ ${s.behind}`) },
    };
  if (s.behind > 0)
    return {
      tone: "info",
      text: t(`GitHub에 새 커밋이 ${s.behind}개 있어요. 풀을 하면 내 컴퓨터로 들어와요.`, `GitHub has ${s.behind} new commit(s). Pull to bring them in.`),
      action: { kind: "pull", label: t(`풀 ↓ ${s.behind}`, `Pull ↓ ${s.behind}`) },
    };
  if (s.ahead > 0)
    return {
      tone: "ready",
      text: t(
        `올릴 커밋이 ${s.ahead}개 쌓였어요. 푸시 한 번에 같이 올라가요.`,
        `${s.ahead} commit(s) are stacked up. One push sends them all.`
      ),
      action: { kind: "push", label: t(`푸시 ↑ ${s.ahead}`, `Push ↑ ${s.ahead}`) },
    };
  if (!s.hasUpstream)
    return {
      tone: "info",
      text: t("이 브랜치는 아직 GitHub에 없어요. 푸시를 하면 새로 만들어져요.", "This branch isn't on GitHub yet. Pushing creates it there."),
      action: { kind: "push", label: t("푸시 ↑", "Push ↑") },
    };
  // 머지는 GitHub에서 PR로 한다. 메인이 아닌 브랜치를 다 올렸으면 다음 할 일은 PR이다
  if (s.branch !== s.mainBranch && s.aheadOfMain > 0 && s.repoPageUrl && /^https:\/\/(www\.)?github\.com\//i.test(s.repoPageUrl))
    return {
      tone: "ready",
      text: t(
        `'${s.branch}'는 GitHub에 다 올라가 있어요. 작업이 끝났으면 PR을 만들어 팀원에게 검토를 부탁해요.`,
        `'${s.branch}' is all on GitHub. When you're done, open a PR so a teammate can review it.`
      ),
      action: { kind: "openPR", label: t("PR 만들기 ↗", "Open PR ↗") },
    };
  const elsewhere = s.stashes.find((x) => x.branch !== s.branch);
  if (elsewhere)
    return {
      tone: "info",
      text: t(
        `'${elsewhere.branch}' 브랜치에 잠시 치워둔 변경이 있어요. 그 브랜치로 가면 다시 꺼낼 수 있어요.`,
        `You have stashed changes on '${elsewhere.branch}'. Switch there to restore them.`
      ),
    };
  return {
    tone: "ok",
    text: t(
      `'${s.branch}' 브랜치는 GitHub과 같아요. 파일을 고치고 저장하면 여기에 나타나요.`,
      `'${s.branch}' is up to date with GitHub. Edit and save a file to get started.`
    ),
  };
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <div className={`notice ${tone ?? ""}`}>
      <p>{children}</p>
    </div>
  );
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const nameOf = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
/** origin/login-fix → login-fix */
const shortName = (p: string) => p.replace(/^[^/]+\//, "");
