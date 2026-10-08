import * as fs from "fs";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import { t } from "./lang";
import { webUrlFromRemote } from "./cloneUrl";

/** 웹뷰에 보내는 파일 하나의 상태 */
/** 파일이 어떻게 바뀌었는지. 화면이 언어에 맞게 글자로 바꿔 보여준다 */
export type FileKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "conflict" | "changed";

export interface FileChange {
  path: string;
  label: FileKind;
  /** git add 된 상태인지 */
  staged: boolean;
  /** git이 아직 한 번도 기록한 적 없는 새 파일 (.gitignore 안내·버리기에 쓴다) */
  untracked: boolean;
  /** 워킹 트리에도 변경이 있는지 (staged 이후 또 고친 경우) */
  dirty: boolean;
  /** 늘어난 줄 / 줄어든 줄. 사진 같은 파일이면 binary */
  added?: number;
  deleted?: number;
  binary?: boolean;
}

type LineStat = { added: number; deleted: number; binary: boolean };

export interface BranchInfo {
  name: string;
  current: boolean;
  /** origin/xxx 처럼 원격 브랜치인지 */
  remote: boolean;
  /** 내 컴퓨터에서 이 브랜치를 만든 시각(초). 기록이 없으면 0 */
  createdAt: number;
}

/** 그래프에 그릴 커밋 하나 */
export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  /** ISO 날짜. "3일 전" 같은 표현은 화면에서 만든다 */
  date: string;
  subject: string;
  /** 이 커밋에 붙은 이름들. "main", "origin/main", "tag: v1" */
  refs: string[];
}

/** 웹뷰가 화면을 그리는 데 필요한 모든 것 */
export interface RepoState {
  isRepo: boolean;
  /** 열려 있는 폴더 이름 (시작 화면 문구용) */
  folder: string;
  /** GitHub 주소(remote)가 연결돼 있는지. 없으면 푸시·풀을 할 수 없다 */
  hasRemote: boolean;
  /** 연결된 저장소의 웹 페이지 주소 (윗줄 바로가기 버튼용). 없거나 못 알아보면 null */
  repoPageUrl: string | null;
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  files: FileChange[];
  branches: BranchInfo[];
  commits: Commit[];
  /** 잠시 치워둔(stash) 변경 묶음들. 최근 것이 앞 */
  stashes: StashInfo[];
  /** 지금 브랜치에만 있고 메인에는 아직 없는 커밋 수. PR 버튼을 띄울지 정할 때 쓴다 */
  aheadOfMain: number;
  /** 그래프의 기준이 되는 메인 브랜치 이름 (origin/ 없이). 못 찾으면 지금 브랜치 */
  mainBranch: string;
  merge: MergeState | null;
}

/** 잠시 치워둔 변경 묶음 하나 */
export interface StashInfo {
  /** stash@{0} 같은 이름. 꺼낼 때 쓴다 */
  ref: string;
  /** 치워둘 때 있던 브랜치 */
  branch: string;
}

/** 합치다가(풀) 충돌한 파일 하나 */
export interface ConflictFile {
  path: string;
  /** 내 쪽에 이 파일이 있는지 (없으면 내 쪽에서 지운 것) */
  ours: boolean;
  /** 들어오는 쪽에 이 파일이 있는지 */
  theirs: boolean;
  /** 파일 안에 남은 <<<<<<< 표시 개수 = 직접 고쳐야 할 곳 */
  markers: number;
  /** 충돌한 곳의 양쪽 내용 (앞의 몇 개만, 길면 잘라서) */
  hunks: { ours: string; theirs: string }[];
}

/** 합치는 중인 상태. 아니면 null */
export interface MergeState {
  /** 들어오는 쪽 브랜치 이름. 못 찾으면 "" */
  from: string;
  /** 들어오는 쪽이 GitHub에서 받아온 것인지 (풀, main 최신 내용 받아오기) */
  fromRemote: boolean;
  conflicts: ConflictFile[];
  /** 내 쪽 끝 커밋 (합치기 전의 HEAD) */
  head: string;
  /** 합쳐 들어오는 쪽 끝 커밋 (.git/MERGE_HEAD) */
  incoming: string;
  /** 두 갈래가 갈라져 나온 공통 커밋. 못 찾으면 "" */
  base: string;
}

/** 커밋 하나에서 바뀐 파일 */
export interface CommitFile {
  path: string;
  /** 이름이 바뀐 경우 예전 경로 */
  oldPath?: string;
  label: FileKind;
  added?: number;
  deleted?: number;
  binary?: boolean;
}

/**
 * env를 직접 넘기면 simple-git이 EDITOR·PAGER 같은 흔한 변수까지 위험으로 보고 막는다.
 * 여기서 넘기는 건 어차피 git이 그냥 실행돼도 물려받았을 사용자 본인의 환경이라 통과시킨다.
 */
const UNSAFE_OK = {
  unsafe: {
    allowUnsafeAskPass: true,
    allowUnsafeConfigEnvCount: true,
    allowUnsafeConfigPaths: true,
    // 아래 githubCredentialConfig 는 사용자 입력이 섞이지 않은 고정 문장이다
    allowUnsafeCredentialHelper: true,
    allowUnsafeDiffExternal: true,
    allowUnsafeEditor: true,
    allowUnsafeGitProxy: true,
    allowUnsafePager: true,
    allowUnsafeSshCommand: true,
    allowUnsafeTemplateDir: true,
  },
};

/** GitHub 로그인으로 받은 계정 이름과 토큰 */
export interface GitAuth {
  user: string;
  token: string;
}

/**
 * git 메시지는 영어로 고정한다 (사용자 언어에 따라 문구가 바뀌면 에러를 알아볼 수 없다).
 * 확장 안에는 비밀번호를 칠 터미널이 없어서, 로그인이 필요하면 멈추지 말고 바로 실패하게 한다.
 */
const baseEnv = () => ({ ...process.env, LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0" });

/**
 * github.com 에 접속할 때만 쓰는 임시 로그인 도우미. 토큰은 명령줄이 아니라 환경변수로 넘긴다.
 * 빈 값으로 먼저 목록을 비우는 이유: 키체인에 남아 있던 옛 비밀번호가 먼저 쓰이거나,
 * 이 토큰이 키체인에 저장되는 걸 막으려고. 주소를 github.com 으로 한정해서 다른 사이트 설정은 그대로 둔다.
 */
const GITHUB_HELPER = "credential.https://github.com.helper";
const githubCredentialConfig = [
  `${GITHUB_HELPER}=`,
  `${GITHUB_HELPER}=!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$EASYGIT_GH_USER" "$EASYGIT_GH_TOKEN"; }; f`,
];

export class GitService {
  private git: SimpleGit;
  /** 저장소 맨 위 폴더. git이 알려주는 파일 경로는 전부 여기 기준이다. 저장소가 아니면 folder와 같다 */
  root: string;

  /** folder: VS Code에서 연 폴더. 저장소 안의 하위 폴더일 수도 있다 */
  constructor(public readonly folder: string) {
    this.root = folder;
    this.git = this.client();
  }

  private client(auth?: GitAuth): SimpleGit {
    if (!auth) return simpleGit({ baseDir: this.root, ...UNSAFE_OK }).env(baseEnv());
    return simpleGit({ baseDir: this.root, config: githubCredentialConfig, ...UNSAFE_OK }).env({
      ...baseEnv(),
      EASYGIT_GH_USER: auth.user,
      EASYGIT_GH_TOKEN: auth.token,
    });
  }

  private moveTo(dir: string) {
    if (path.resolve(dir) === path.resolve(this.root)) return;
    this.root = dir;
    this.git = this.client();
  }

  /**
   * 지금 폴더를 git 저장소로 만든다. 파일은 건드리지 않는다.
   * 기본 브랜치 이름은 git 버전·설정마다 master/main이 갈리니 main으로 맞춘다
   * (init -b 는 오래된 git에 없어서 symbolic-ref로 바꾼다).
   */
  async init(): Promise<void> {
    await this.git.init();
    await this.git.raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  }

  /**
   * parentDir 안에 name 폴더를 만들어 저장소를 복사해 온다. 만들어진 폴더 경로를 돌려준다.
   * 로그인 창을 띄울 수 없는 환경이라, 인증이 필요하면 멈추지 말고 바로 실패하게 한다.
   */
  static async clone(url: string, parentDir: string, name: string, auth?: GitAuth): Promise<string> {
    const env = auth
      ? { ...baseEnv(), EASYGIT_GH_USER: auth.user, EASYGIT_GH_TOKEN: auth.token }
      : baseEnv();
    const config = auth ? githubCredentialConfig : [];
    await simpleGit({ baseDir: parentDir, config, ...UNSAFE_OK }).env(env).clone(url, name);
    return path.join(parentDir, name);
  }

  /**
   * 저장소인지 확인하면서, 연 폴더가 저장소의 하위 폴더면 맨 위 폴더로 기준을 옮긴다.
   * 안 옮기면 git이 주는 "src/app.js" 같은 경로를 하위 폴더에 또 붙여 엉뚱한 파일을 찾는다.
   */
  async isRepo(): Promise<boolean> {
    try {
      const top = (
        await simpleGit({ baseDir: this.folder, ...UNSAFE_OK }).env(baseEnv()).revparse(["--show-toplevel"])
      ).trim();
      if (!top) return false;
      this.moveTo(top);
      return true;
    } catch {
      this.moveTo(this.folder);
      return false;
    }
  }

  /** origin 주소. 연결 안 됐으면 null */
  async remoteUrl(): Promise<string | null> {
    try {
      return (await this.git.remote(["get-url", "origin"]))?.trim() || null;
    } catch {
      return null;
    }
  }

  async addRemote(url: string): Promise<void> {
    await this.git.addRemote("origin", url);
  }

  /** 연결하기 전에 GitHub 저장소가 비어 있는지 본다. 주소가 틀리거나 권한이 없으면 git 에러를 그대로 던진다 */
  async isRemoteEmpty(url: string, auth?: GitAuth): Promise<boolean> {
    return (await this.client(auth).listRemote([url])).trim() === "";
  }

  /** 브랜치 이름만 필요할 때. 저장할 때마다 전체 상태를 읽는 건 무겁다 */
  async currentBranch(): Promise<string | null> {
    try {
      return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    } catch {
      return null;
    }
  }

  async getState(): Promise<RepoState> {
    const folder = path.basename(this.folder);
    if (!(await this.isRepo())) {
      return {
        isRepo: false,
        folder,
        hasRemote: false,
        repoPageUrl: null,
        branch: "",
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        files: [],
        branches: [],
        commits: [],
        stashes: [],
        mainBranch: "",
        aheadOfMain: 0,
        merge: null,
      };
    }

    const [status, branchSummary, commits, stashes, remotes, remoteDefault, originUrl] = await Promise.all([
      this.git.status(),
      this.git.branch(["-a"]),
      this.log(),
      this.listStashes(),
      this.git.getRemotes(),
      this.remoteDefaultBranch(),
      this.remoteUrl(),
    ]);

    const stats = status.files.length > 0 ? await this.workingStats(commits.length > 0) : new Map<string, LineStat>();
    const files: FileChange[] = status.files.map((f) => {
      // index: 스테이지 영역 상태, working_dir: 작업 폴더 상태
      const idx = f.index.trim();
      const wd = f.working_dir.trim();
      const staged = idx !== "" && idx !== "?";
      const dirty = wd !== "";
      const code = staged ? idx : wd;
      return {
        path: f.path,
        label: describe(code, f.index, f.working_dir),
        staged,
        dirty,
        untracked: idx === "?",
        ...(stats.get(f.path) ?? this.newFileStat(f.path)),
      };
    });

    const branches: BranchInfo[] = Object.values(branchSummary.branches)
      .filter((b) => !b.name.includes("HEAD ->") && !b.name.endsWith("/HEAD"))
      .map((b) => ({
        name: b.name.replace(/^remotes\//, ""),
        current: b.current,
        remote: b.name.startsWith("remotes/"),
        createdAt: 0,
      }));
    const gitDir = await this.gitDir();
    for (const b of branches) if (!b.remote && gitDir) b.createdAt = branchCreatedAt(gitDir, b.name);

    const branch = status.current ?? "";
    const known = (n: string) => branches.some((b) => b.name === n || b.name === `origin/${n}`);
    // GitHub 저장소에 정해 둔 기본 브랜치 → main → master → 지금 브랜치
    const mainBranch = [remoteDefault, "main", "master"].find((n): n is string => !!n && known(n)) ?? branch;

    const merge = await this.mergeState(files.filter((f) => f.label === "conflict").map((f) => f.path));
    // PR은 GitHub의 메인과 비교하므로 origin 쪽을 기준으로 센다. 합쳐진 뒤 받아오면 0이 돼서 버튼도 저절로 사라진다
    const mainRef = branches.some((b) => b.name === `origin/${mainBranch}`) ? `origin/${mainBranch}` : mainBranch;
    const aheadOfMain = branch && branch !== mainBranch ? await this.countAhead(mainRef) : 0;

    return {
      isRepo: true,
      folder,
      mainBranch,
      aheadOfMain,
      merge,
      hasRemote: remotes.length > 0,
      repoPageUrl: originUrl ? webUrlFromRemote(originUrl) : null,
      branch,
      ahead: status.ahead,
      behind: status.behind,
      hasUpstream: !!status.tracking,
      files,
      branches,
      commits,
      stashes,
    };
  }

  /** 그래프용 커밋 목록. 로컬·원격 브랜치를 모두(--all) 가져온다 */
  private async log(): Promise<Commit[]> {
    const FIELD = "\x1f";
    const ROW = "\x1e";
    const format = ["%H", "%P", "%an", "%aI", "%s", "%D"].join(FIELD) + ROW;
    try {
      const out = await this.git.raw([
        "log",
        // 잠시 치워둔(stash) 꾸러미는 git이 커밋으로 만들어 두지만 그래프에 보일 것은 아니다
        "--exclude=refs/stash",
        "--all",
        "--date-order",
        "--max-count=200",
        `--pretty=format:${format}`,
      ]);
      return out
        .split(ROW)
        .map((row) => row.trim())
        .filter(Boolean)
        .map((row) => {
          const [hash, parents, author, date, subject, refs] = row.split(FIELD);
          return {
            hash,
            parents: parents ? parents.split(" ").filter(Boolean) : [],
            author,
            date,
            subject: subject ?? "",
            refs: (refs ?? "")
              .split(",")
              .map((r) => r.replace("HEAD ->", "").trim())
              // origin/HEAD는 origin/main을 가리키는 별칭일 뿐이라 화면에 둘 필요가 없다
              .filter((r) => r && r !== "HEAD" && !r.endsWith("/HEAD")),
          };
        });
    } catch {
      return []; // 커밋이 하나도 없는 새 저장소
    }
  }

  private gitDirCache: string | null = null;
  private async gitDir(): Promise<string | null> {
    if (this.gitDirCache) return this.gitDirCache;
    try {
      this.gitDirCache = (await this.git.raw(["rev-parse", "--absolute-git-dir"])).trim();
    } catch {
      return null;
    }
    return this.gitDirCache;
  }

  /** 가져온(clone) 저장소라면 GitHub에 정해 둔 기본 브랜치 이름. 없으면 null */
  private async remoteDefaultBranch(): Promise<string | null> {
    try {
      const ref = (await this.git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
      return ref.replace(/^origin\//, "") || null;
    } catch {
      return null;
    }
  }

  /**
   * 커밋 하나가 바꾼 파일들. 합친(merge) 커밋은 첫 부모와 비교해서 "합치면서 들어온 것"을 보여준다.
   */
  async commitFiles(hash: string): Promise<CommitFile[]> {
    const parents = (await this.git.raw(["rev-list", "--parents", "-n", "1", hash])).trim().split(" ").slice(1);
    const args = parents.length
      ? ["diff-tree", "-r", "-M", "--name-status", "--no-commit-id", parents[0], hash]
      : ["diff-tree", "-r", "-M", "--name-status", "--no-commit-id", "--root", hash];
    // -z: 이게 없으면 git이 한글 경로를 "\354\203\210…" 처럼 바꿔서 내보낸다
    const [out, stats] = await Promise.all([
      this.git.raw([...args, "-z"]),
      this.numstat(args.filter((a) => a !== "--name-status")),
    ]);
    const tokens = out.split("\0");
    const files: CommitFile[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const code = tokens[i];
      if (!code) continue;
      const kind = code[0];
      const file =
        kind === "R" || kind === "C"
          ? { path: tokens[i + 2], oldPath: tokens[i + 1], label: (kind === "R" ? "renamed" : "copied") as FileKind }
          : { path: tokens[i + 1], label: describe(kind, kind, "") };
      i += kind === "R" || kind === "C" ? 2 : 1;
      files.push({ ...file, ...stats.get(file.path) });
    }
    return files;
  }

  /** git diff --numstat 결과를 경로별 줄 수로. -z 형식이라 이름에 빈칸·한글이 있어도 안전하다 */
  private async numstat(args: string[]): Promise<Map<string, LineStat>> {
    const out = await this.git.raw([...args, "--numstat", "-z"]);
    const tokens = out.split("\0");
    const map = new Map<string, LineStat>();
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i]) continue;
      const [a, d, p] = tokens[i].split("\t");
      if (d === undefined) continue;
      // 이름이 바뀐 파일은 "늘어남\t줄어듦\t" 뒤에 예전 경로, 새 경로가 따로 온다
      const file = p ? p : tokens[(i += 2)];
      if (!file) continue;
      map.set(file, { added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d), binary: a === "-" });
    }
    return map;
  }

  /** 커밋 안 한 변경의 줄 수 (마지막 커밋과 비교) */
  private async workingStats(hasHead: boolean): Promise<Map<string, LineStat>> {
    if (!hasHead) return new Map();
    try {
      return await this.numstat(["diff", "-M", "HEAD"]);
    } catch {
      return new Map();
    }
  }

  /** git이 아직 모르는 새 파일은 파일을 직접 읽어 줄 수를 센다 */
  private newFileStat(file: string): LineStat | undefined {
    try {
      const full = path.join(this.root, file);
      const st = fs.statSync(full);
      if (!st.isFile()) return undefined;
      if (st.size > 2 * 1024 * 1024) return { added: 0, deleted: 0, binary: true };
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) return { added: 0, deleted: 0, binary: true };
      const text = buf.toString("utf8");
      const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      return { added: lines, deleted: 0, binary: false };
    } catch {
      return undefined;
    }
  }

  /**
   * 브랜치를 지우기 전에 알려줄 것들.
   * lost: 이 브랜치에만 있어서 지우면 찾기 어려워지는 커밋 제목들 (다른 브랜치나 GitHub에 있는 커밋은 안 센다)
   */
  async branchDeleteInfo(name: string, mainRef: string): Promise<{ merged: boolean; onGitHub: boolean; lost: string[] }> {
    const [ahead, remote, lost] = await Promise.all([
      this.git.raw(["rev-list", "--count", `${mainRef}..refs/heads/${name}`]).then((o) => parseInt(o.trim(), 10) || 0, () => 1),
      this.git.raw(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]).then(() => true, () => false),
      this.git
        .raw(["log", "--format=%s", `refs/heads/${name}`, "--not", "--remotes", `--exclude=${name}`, "--branches"])
        .then((o) => o.split("\n").filter(Boolean), () => [] as string[]),
    ]);
    return { merged: ahead === 0, onGitHub: remote, lost };
  }

  /** 내 컴퓨터의 브랜치만 지운다. GitHub 쪽은 건드리지 않는다. 확인은 부르는 쪽에서 이미 받았다 */
  async deleteBranch(name: string): Promise<void> {
    await this.git.raw(["branch", "-D", "--", name]);
  }

  private async countAhead(base: string): Promise<number> {
    try {
      return parseInt((await this.git.raw(["rev-list", "--count", `${base}..HEAD`])).trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private async listStashes(): Promise<StashInfo[]> {
    try {
      const out = await this.git.raw(["stash", "list", "--format=%gd%x00%gs"]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [ref, subject = ""] = line.split("\0");
          // "On main: 메시지" 또는 "WIP on main: abc123 커밋제목" — 언어 설정과 상관없이 git이 이 모양으로 남긴다
          return { ref, branch: subject.match(/^(?:WIP on|On) ([^:]+):/)?.[1] ?? "" };
        });
    } catch {
      return [];
    }
  }

  /**
   * 이메일을 직접 설정했는지. 안 했으면 git이 "계정@컴퓨터이름.local" 같은 가짜 주소를 지어내서
   * 커밋은 되지만 GitHub에서 내 계정 커밋으로 연결되지 않는다.
   */
  async hasIdentity(): Promise<boolean> {
    try {
      return !!(await this.git.getConfig("user.email")).value;
    } catch {
      return false;
    }
  }

  /** 지금 커밋에 남는 이름·이메일 (설정 안 했으면 빈 문자열) */
  async getIdentity(): Promise<{ name: string; email: string }> {
    const read = async (key: string) => {
      try {
        return (await this.git.getConfig(key)).value ?? "";
      } catch {
        return "";
      }
    };
    const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
    return { name, email };
  }

  /** 커밋에 남는 이름·이메일. 모든 저장소에 한 번에 적용되게 전역으로 저장한다 */
  async setIdentity(name: string, email: string): Promise<void> {
    await this.git.addConfig("user.name", name, false, "global");
    await this.git.addConfig("user.email", email, false, "global");
  }

  /** 체크한 파일만 add 하고 커밋 */
  async commit(paths: string[], message: string): Promise<void> {
    // "--"로 끊어야 파일 이름이 -로 시작해도 옵션으로 오해받지 않는다
    if (paths.length > 0) await this.git.add(["--", ...paths]);
    await this.git.commit(message);
  }

  /** upstream이 없으면 origin에 브랜치를 새로 만들면서 올린다 */
  async push(auth?: GitAuth): Promise<void> {
    const status = await this.git.status();
    const git = this.client(auth);
    if (status.tracking) {
      await git.push();
      return;
    }
    if (!status.current) throw new Error(t("지금 어떤 브랜치에 있는지 알 수 없어요.", "Can't tell which branch you're on."));
    await git.push(["-u", "origin", status.current]);
  }

  /**
   * --no-rebase를 붙이는 이유: 설정을 안 해두면 git이 "rebase냐 merge냐 정하라"며 멈춰 선다.
   * 초보자에게 그 선택을 시키느니, 되돌리기 쉬운 merge로 고정한다.
   */
  async pull(auth?: GitAuth): Promise<void> {
    await this.client(auth).pull(["--no-rebase"]);
  }

  /**
   * 메인 브랜치의 최신 내용을 지금 브랜치로 합친다 (메인은 안 바뀐다).
   * PR이 "This branch has conflicts"일 때 내 브랜치에서 풀어 주는 흔한 방법이다.
   * GitHub 쪽 메인(origin/main)이 있으면 그걸, 없으면 내 컴퓨터의 메인을 쓴다.
   */
  async mergeFromMain(main: string, auth?: GitAuth): Promise<void> {
    const remotes = await this.git.getRemotes();
    if (remotes.some((r) => r.name === "origin")) await this.client(auth).fetch("origin");
    const refs = (await this.git.raw(["branch", "-a", "--format=%(refname:short)"])).split("\n").map((r) => r.trim());
    const source = refs.includes(`origin/${main}`) ? `origin/${main}` : main;
    await this.git.raw(["merge", "--no-edit", source]);
  }

  /**
   * 새 브랜치를 만들고 그리로 옮긴다. 고치던 파일은 따라온다.
   * from을 주면 지금 자리가 아니라 그 커밋에서 갈라져 나온다.
   */
  async createBranch(name: string, from?: string): Promise<void> {
    await this.git.checkout(from ? ["-b", name, from] : ["-b", name]);
  }

  /**
   * 브랜치 갈아타기. GitHub에만 있는 브랜치면 같은 이름의 로컬 브랜치를 만들어 연결한다
   * ("가져오기"에 해당).
   */
  async switchBranch(name: string, remote: boolean): Promise<void> {
    if (!remote) {
      await this.git.checkout([name]);
      return;
    }
    const local = name.replace(/^[^/]+\//, "");
    const existing = await this.git.branchLocal();
    if (existing.all.includes(local)) await this.git.checkout([local]);
    else await this.git.checkout(["-b", local, "--track", name]);
  }

  /**
   * 어떤 시점(ref)의 파일 내용. 그 시점에 파일이 없었으면(새로 만든 파일의 "전", 지운 파일의 "후") 빈 문자열.
   * 비교 화면이 한쪽이 없다고 통째로 실패하지 않게 하려는 것이다.
   */
  async showFile(ref: string, relPath: string): Promise<string> {
    await this.isRepo();
    try {
      return await this.git.raw(["show", `${ref}:${relPath.split(path.sep).join("/")}`]);
    } catch {
      return "";
    }
  }

  /**
   * 합치는 중인지(.git/MERGE_HEAD가 있는지) 보고, 충돌한 파일마다 양쪽에 파일이 있는지·고칠 곳이 몇 개인지 센다.
   */
  private async mergeState(conflicted: string[]): Promise<MergeState | null> {
    const gitDir = await this.gitDir();
    if (!gitDir || !fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return null;

    let from = "";
    let fromRemote = false;
    try {
      const msg = fs.readFileSync(path.join(gitDir, "MERGE_MSG"), "utf8").split("\n")[0];
      // 풀: "Merge branch 'test2' of https://github.com/me/app" / 받아오기: "Merge remote-tracking branch 'origin/main'"
      const m = msg.match(/^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'( of )?/);
      if (m) {
        from = m[1];
        fromRemote = !!m[2] || msg.includes("origin/");
      }
    } catch {
      /* 이름을 못 찾아도 해결은 할 수 있다 */
    }

    // 두 갈래를 화면에 나란히 그리려면 양쪽 끝과 갈라진 자리가 필요하다
    let head = "";
    let incoming = "";
    let base = "";
    try {
      head = (await this.git.raw(["rev-parse", "HEAD"])).trim();
      incoming = fs.readFileSync(path.join(gitDir, "MERGE_HEAD"), "utf8").trim().split("\n")[0];
      base = (await this.git.raw(["merge-base", head, incoming])).trim();
    } catch {
      /* 못 찾아도 충돌을 푸는 데는 지장이 없다 */
    }

    let stages = "";
    try {
      stages = await this.git.raw(["ls-files", "-u", "-z"]);
    } catch {
      /* 빈 채로 */
    }
    // "모드 해시 단계\t경로" — 단계 2가 내 쪽, 3이 들어오는 쪽
    const has = new Map<string, Set<string>>();
    for (const entry of stages.split("\0").filter(Boolean)) {
      const [meta, file] = entry.split("\t");
      const stage = meta.split(" ")[2];
      if (!has.has(file)) has.set(file, new Set());
      has.get(file)!.add(stage);
    }

    const conflicts = conflicted.map((file) => {
      let text = "";
      try {
        text = fs.readFileSync(path.join(this.root, file), "utf8");
      } catch {
        /* 한쪽에서 지워서 파일이 없을 수 있다 */
      }
      const st = has.get(file) ?? new Set();
      return { path: file, ours: st.has("2"), theirs: st.has("3"), ...conflictHunks(text) };
    });
    return { from, fromRemote, conflicts, head, incoming, base };
  }

  /** 충돌한 파일을 한쪽 내용으로 통째로 정한다. 그쪽에 파일이 없으면(지운 쪽을 고르면) 파일을 지운다 */
  async resolveWith(file: string, side: "ours" | "theirs"): Promise<void> {
    const state = await this.mergeState([file]);
    const pick = state?.conflicts[0];
    if (pick && !pick[side]) {
      await this.git.raw(["rm", "--quiet", "--", file]);
      return;
    }
    await this.git.raw(["checkout", `--${side}`, "--", file]);
    await this.git.raw(["add", "--", file]);
  }

  /** 직접 고친 파일을 해결됨으로 표시. 아직 <<<<<<< 표시가 남아 있으면 그 개수를 돌려주고 표시하지 않는다 */
  async markResolved(file: string): Promise<number> {
    let markers = 0;
    try {
      markers = (fs.readFileSync(path.join(this.root, file), "utf8").match(/^<{7}( |$)/gm) ?? []).length;
    } catch {
      await this.git.raw(["rm", "--quiet", "--cached", "--", file]);
      return 0;
    }
    if (markers > 0) return markers;
    await this.git.raw(["add", "--", file]);
    return 0;
  }

  /** 충돌한 곳을 다 정했으면 합친 커밋을 만든다 (git이 준비해 둔 "Merge branch …" 메시지 그대로) */
  async finishMerge(): Promise<void> {
    await this.git.raw(["commit", "--no-edit"]);
  }

  /** 합치기를 그만두고 풀 하기 전 상태로 돌아간다 */
  async abortMerge(): Promise<void> {
    await this.git.raw(["merge", "--abort"]);
  }

  /** 이 커밋이 지금 브랜치의 과거에 들어 있는지 */
  async isOnCurrentBranch(hash: string): Promise<boolean> {
    try {
      return (await this.git.raw(["merge-base", hash, "HEAD"])).trim() === hash;
    } catch {
      return false;
    }
  }

  /** GitHub(원격) 브랜치 어디에든 이미 올라가 있는지 */
  async isPushed(hash: string): Promise<boolean> {
    const out = await this.git.raw(["branch", "-r", "--contains", hash, "--format=%(refname:short)"]);
    return out.split("\n").some((r) => r.trim() && !r.trim().endsWith("/HEAD"));
  }

  /** 이 커밋 뒤에 지금 브랜치에 쌓인 커밋 수 */
  async commitsAfter(hash: string): Promise<number> {
    return parseInt((await this.git.raw(["rev-list", "--count", `${hash}..HEAD`])).trim(), 10) || 0;
  }

  async commitMessage(hash: string): Promise<string> {
    return (await this.git.raw(["log", "-1", "--format=%B", hash])).trim();
  }

  /**
   * 아직 안 올린 커밋 취소. 브랜치를 이 커밋 바로 전으로 돌리되 (--mixed),
   * 커밋에 담겼던 내용은 지우지 않고 "바뀐 파일"로 돌려놓는다. 이 뒤에 한 커밋들도 같이 풀린다.
   */
  async undoCommit(hash: string): Promise<void> {
    await this.git.raw(["reset", "--mixed", `${hash}^`]);
  }

  /**
   * 이미 올린 커밋은 기록을 지우는 대신, 반대로 되돌리는 새 커밋을 만든다.
   * 중간에 막히면 반쯤 된 상태로 두지 않고 원래대로 돌려놓는다.
   */
  async revertCommit(hash: string, isMerge: boolean): Promise<void> {
    const subject = (await this.git.raw(["log", "-1", "--format=%s", hash])).trim();
    try {
      await this.git.raw(["revert", "--no-edit", ...(isMerge ? ["-m", "1"] : []), hash]);
    } catch (e) {
      await this.git.raw(["revert", "--abort"]).catch(() => undefined);
      throw e;
    }
    // git이 붙이는 영어 제목(Revert "...")을 알아보기 쉬운 말로 바꾼다.
    // --only: 스테이지에 올라가 있던 다른 변경이 이 커밋에 섞여 들어가지 않게, 메시지만 고친다
    await this.git.raw([
      "commit", "--amend", "--only",
      "-m", t(`되돌림: ${subject}`, `Revert: ${subject}`),
      "-m", t(`되돌린 커밋: ${hash}`, `Reverted commit: ${hash}`),
    ]);
  }

  /** 커밋 안 한 변경을 통째로 잠시 치워둔다 (새 파일 포함) */
  async stash(message: string): Promise<void> {
    await this.git.stash(["push", "--include-untracked", "-m", message]);
  }

  /**
   * 치워둔 변경을 다시 꺼낸다. 바뀐 파일이 하나도 없을 때만 부른다.
   * 그 사이 브랜치가 바뀌어서 겹치는 곳이 생기면, 반쯤 섞인 상태로 두지 않고 꺼내기 전으로 되돌린다.
   * 치워둔 묶음은 성공했을 때만 지우므로 실패해도 잃는 것이 없다.
   */
  async popStash(ref: string): Promise<void> {
    try {
      await this.git.raw(["stash", "apply", ref]);
    } catch (e) {
      // 꺼내기 전에는 바뀐 파일이 없었으니, 지금 바뀐 것은 전부 방금 꺼내다 생긴 것이다
      await this.git.raw(["reset", "--hard", "HEAD"]).catch(() => undefined);
      await this.git.raw(["clean", "-fd"]).catch(() => undefined);
      throw e;
    }
    await this.git.raw(["stash", "drop", ref]);
  }

  /**
   * 파일 하나의 변경을 버리고 마지막 커밋 상태로 돌린다.
   * 새로 만든 파일은 git이 되돌릴 원본이 없으므로 기록에서만 빼고, 파일 삭제는 부르는 쪽이 휴지통으로 한다.
   */
  async discard(file: FileChange): Promise<void> {
    if (file.label === "added") {
      if (!file.untracked) await this.git.raw(["rm", "--cached", "-r", "--quiet", "--", file.path]);
      return;
    }
    await this.git.raw(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
  }

  /**
   * 원격의 최신 정보만 받아온다 (내 파일은 안 바뀜).
   * 이걸 해야 "GitHub에 새 커밋 N개"를 알 수 있다. 오프라인 등으로 실패해도 그냥 넘어간다.
   */
  async fetchQuietly(auth?: GitAuth): Promise<void> {
    try {
      await this.client(auth).fetch();
    } catch {
      /* 화면에 띄울 만한 일이 아니다 */
    }
  }
}

/**
 * 브랜치를 만든 시각. git은 커밋에 브랜치를 기록하지 않지만, 내 컴퓨터의 reflog 첫 줄에
 * "…  1757750000 +0900\tbranch: Created from HEAD" 처럼 만든 순간이 남는다.
 * 같은 커밋을 가리키는 두 브랜치 중 어느 쪽이 먼저 있었는지 가릴 때만 쓴다.
 */
function branchCreatedAt(gitDir: string, name: string): number {
  try {
    const first = fs.readFileSync(path.join(gitDir, "logs", "refs", "heads", name), "utf8").split("\n")[0];
    const m = first.match(/ (\d{9,}) [+-]\d{4}\t/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * <<<<<<< 내 쪽
 * (내 거)
 * ||||||| 원래 (diff3 설정일 때만)
 * =======
 * (팀원 거)
 * >>>>>>> 들어오는 쪽
 */
function conflictHunks(text: string): { markers: number; hunks: { ours: string; theirs: string }[] } {
  const clip = (lines: string[]) =>
    lines.length > 8 ? [...lines.slice(0, 8), t(`… (${lines.length - 8}줄 더)`, `… (${lines.length - 8} more lines)`)].join("\n") : lines.join("\n");
  const hunks: { ours: string; theirs: string }[] = [];
  let markers = 0;
  let mode: "none" | "ours" | "base" | "theirs" = "none";
  let ours: string[] = [];
  let theirs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^<{7}( |$)/.test(line)) {
      markers++;
      mode = "ours";
      ours = [];
      theirs = [];
    } else if (mode === "ours" && /^\|{7}( |$)/.test(line)) mode = "base";
    else if ((mode === "ours" || mode === "base") && /^={7}$/.test(line)) mode = "theirs";
    else if (mode === "theirs" && /^>{7}( |$)/.test(line)) {
      if (hunks.length < 3) hunks.push({ ours: clip(ours), theirs: clip(theirs) });
      mode = "none";
    } else if (mode === "ours") ours.push(line);
    else if (mode === "theirs") theirs.push(line);
  }
  return { markers, hunks };
}

function describe(code: string, index: string, workingDir: string): FileKind {
  if (index === "U" || workingDir === "U" || (index === "A" && workingDir === "A") || (index === "D" && workingDir === "D")) {
    return "conflict";
  }
  switch (code) {
    case "M":
      return "modified";
    case "A":
    case "?":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "changed";
  }
}
