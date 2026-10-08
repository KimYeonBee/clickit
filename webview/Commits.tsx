import { useEffect, useRef } from "react";
import type { Commit, BranchInfo, MergeState } from "../src/gitService";
import { ago, t } from "./i18n";

/** 이름을 알 수 없는 브랜치. 화면에서 "다른 브랜치"로 보여준다 */
const UNKNOWN = "";
const nameOf = (source: string) => source || t("다른 브랜치", "another branch");

/** 목록을 어느 쪽부터 보여줄지 */
export type Order = "new" | "old";

/** 커밋 한 칸이 지금 어디까지 가 있는지 */
export type Stage =
  /** GitHub에만 있고 내 컴퓨터엔 아직 없음 (풀 하기 전) */
  | "remote"
  /** 내 컴퓨터에만 있고 GitHub엔 아직 없음 (푸시 하기 전) */
  | "unpushed"
  /** 양쪽에 다 있음 */
  | "synced";

/** 목록에 쌓이는 커밋 하나 */
export interface HistoryItem {
  commit: Commit;
  /** 합친 커밋이면 합쳐 들어온 브랜치 이름 */
  source: string;
  merged: boolean;
  stage: Stage;
}

/**
 * 커밋 하나에 대해 화면이 알아야 하는 사실들.
 * "올렸나"는 GitHub 브랜치 어디에서든 닿을 수 있는지로 판단한다.
 */
export function commitFacts(commits: Commit[], branches: BranchInfo[], currentBranch: string) {
  const tipOf = (ref: string) => commits.find((c) => c.refs.includes(ref))?.hash;
  const remoteTips = branches
    .filter((b) => b.remote)
    .map((b) => tipOf(b.name))
    .filter((h): h is string => !!h);
  const pushed = reachable(commits, remoteTips);
  const currentTip = tipOf(currentBranch);
  const onCurrent = currentTip ? reachable(commits, [currentTip]) : new Set<string>();
  const hasRemote = branches.some((b) => b.remote);

  return {
    /** GitHub이 연결돼 있는데 아직 안 올린 커밋 */
    isUnpushed: (hash: string) => hasRemote && !pushed.has(hash),
    isPushed: (hash: string) => pushed.has(hash),
    isOnCurrent: (hash: string) => onCurrent.has(hash),
    /** 이 커밋을 과거에 품고 있는 내 브랜치들 */
    localBranchesWith: (hash: string) =>
      branches
        .filter((b) => !b.remote)
        .filter((b) => {
          const tip = tipOf(b.name);
          return !!tip && reachable(commits, [tip]).has(hash);
        })
        .map((b) => b.name),
  };
}

export interface History {
  /** 최신이 맨 앞 */
  items: HistoryItem[];
  /** 이 브랜치가 갈라져 나온 자리. 목록 맨 끝에 한 칸으로 보여준다 (메인이거나 알 수 없으면 null) */
  fork: { name: string; commit: Commit; exists: boolean } | null;
}

/**
 * 한 브랜치에서 "직접 한" 커밋만 최신 → 옛날 순으로 편다.
 *
 * - 메인 브랜치: 메인에서 직접 한 커밋 + 다른 브랜치를 합친 커밋. 합쳐 들어온 브랜치 안의 커밋은 안 보여준다.
 * - 다른 브랜치: 그 브랜치에서 한 커밋만. 갈라져 나오기 전의 역사는 안 보여주므로 막 만든 브랜치는 비어 있다.
 *
 * 어느 커밋이 어느 브랜치에서 한 것인지는 git에 기록이 없어서 이렇게 정한다.
 * 1) 메인의 첫 부모를 따라가며 메인 것으로, 머지 커밋에서 합쳐 들어온 쪽은 그 브랜치 것으로 이름 붙인다.
 *    이름은 머지 제목("Merge branch 'x'", "Merge pull request #1 from me/x") → 그 커밋에 남은 브랜치 이름 순.
 * 2) 보고 있는 브랜치보다 앞서 있던 다른 브랜치(끝이 이 브랜치 역사 안에 있는 것)를 먼저 이름 붙인다.
 *    test2에서 test3을 만들었다면 test2의 커밋이 test3 것으로 잡히지 않게 하려는 것이다.
 * 3) 남은 것이 이 브랜치에서 한 커밋이다.
 *
 * 내 컴퓨터의 브랜치와 GitHub의 같은 브랜치(origin/…)는 합쳐서 본다 — GitHub에서 머지만 하고
 * 아직 풀을 안 했어도 보여야 하기 때문이다.
 */
export function historyOf(
  commits: Commit[],
  branches: BranchInfo[],
  view: string,
  main: string,
  facts: ReturnType<typeof commitFacts>
): History {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const tipsOf = (name: string) =>
    [name, `origin/${name}`]
      .map((ref) => commits.find((c) => c.refs.includes(ref))?.hash)
      .filter((h): h is string => !!h);

  const tips = tipsOf(view);
  if (tips.length === 0) return { items: [], fork: null };
  const inView = reachable(commits, tips);
  const localTips = branches
    .filter((b) => !b.remote)
    .map((b) => commits.find((c) => c.refs.includes(b.name))?.hash)
    .filter((h): h is string => !!h);
  const onMyComputer = reachable(commits, localTips);
  const families = [...new Set(branches.map((b) => shortName(b.name)))];
  /** 내 컴퓨터에서 만든 시각. GitHub에서 받아온 브랜치는 기록이 없어 0 = 가장 오래된 것으로 친다 */
  const createdAt = (name: string) => branches.find((b) => !b.remote && b.name === name)?.createdAt ?? 0;

  /** 커밋에 달린 브랜치 이름표 중 가장 먼저 만들어진 것 (나중에 거기서 갈라져 나온 브랜치보다 원래 주인일 가능성이 높다) */
  const refName = (hash: string) =>
    (byHash.get(hash)?.refs ?? [])
      .map(shortName)
      .filter((r) => families.includes(r) && r !== main)
      .sort((a, b) => createdAt(a) - createdAt(b))[0];

  const visited = new Set<string>();
  const sourceOf = new Map<string, string>();
  const walk = (start: string, name: string) => {
    const chain: Commit[] = [];
    let h: string | undefined = start;
    while (h && byHash.has(h) && !visited.has(h)) {
      visited.add(h);
      const c: Commit = byHash.get(h)!;
      chain.push(c);
      h = c.parents[0];
    }
    for (const c of chain.reverse()) {
      for (const p of c.parents.slice(1)) {
        // 머지 제목에 적힌 이름이 가장 확실하다 (브랜치를 지웠거나 같은 커밋에 이름표가 여럿이어도)
        if (byHash.has(p) && !visited.has(p)) walk(p, mergedName(c.subject) ?? refName(p) ?? UNKNOWN);
      }
      sourceOf.set(c.hash, name);
    }
  };

  tipsOf(main).forEach((tip) => walk(tip, main));
  if (view !== main) {
    const viewTips = new Set(tips);
    for (const f of families) {
      if (f === view || f === main) continue;
      const ft = tipsOf(f);
      // 끝이 같은 커밋이면(커밋 없이 막 만든 브랜치) 먼저 만들어진 쪽이 그 커밋들의 주인이다
      const olderThanView = createdAt(f) < createdAt(view);
      if (ft.length > 0 && ft.every((tip) => inView.has(tip) && (!viewTips.has(tip) || olderThanView))) {
        ft.forEach((tip) => walk(tip, f));
      }
    }
    tips.forEach((tip) => walk(tip, view));
  }

  // git log --date-order 가 준 순서(최신이 앞) 그대로
  const own = commits.filter((c) => inView.has(c.hash) && sourceOf.get(c.hash) === view);

  // 갈라져 나온 곳 = 이 브랜치 가장 오래된 커밋의 부모 (커밋이 없으면 지금 가리키는 커밋)
  let fork: History["fork"] = null;
  if (view !== main) {
    const base = own.length > 0 ? own[own.length - 1].parents[0] : tips[0];
    const name = base ? sourceOf.get(base) : undefined;
    const commit = base ? byHash.get(base) : undefined;
    if (name && commit && name !== view) {
      fork = { name, commit, exists: families.includes(name) };
    }
  }

  const items = own.map((commit): HistoryItem => {
    const merged = commit.parents.length > 1;
    const source = merged
      ? (sourceOf.get(commit.parents[1]) ?? mergedName(commit.subject) ?? UNKNOWN)
      : view;
    const stage: Stage = !onMyComputer.has(commit.hash)
      ? "remote"
      : facts.isUnpushed(commit.hash)
        ? "unpushed"
        : "synced";
    return { commit, source, merged, stage };
  });

  return { items, fork };
}

/** git이 머지 커밋에 붙이는 제목에서 합쳐 들어온 브랜치 이름을 꺼낸다 */
function mergedName(subject: string): string | undefined {
  return (
    subject.match(/^Merge branch '([^']+)'/)?.[1] ??
    subject.match(/^Merge remote-tracking branch '(?:[^/']+\/)?([^']+)'/)?.[1] ??
    subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/)?.[1]
  );
}

/**
 * 커밋 목록. order가 "new"면 위가 최신, "old"면 위가 옛날이다.
 * "커밋 전" 칸은 늘 최신 쪽 끝에, "갈라져 나옴" 칸은 늘 옛날 쪽 끝에 붙는다.
 * 사이사이에 "여기부터 GitHub에 없어요" 같은 구분줄이 들어가 커밋이 어디까지 갔는지가 줄 하나로 보이게 한다.
 */
export function CommitList({
  history,
  order,
  view,
  main,
  selected,
  onSelect,
  pending,
  clash,
  onPending,
  busy,
  onJump,
}: {
  history: History;
  /** "new" = 최신이 맨 위, "old" = 오래된 것이 맨 위 */
  order: Order;
  view: string;
  main: string;
  selected: string | null;
  onSelect: (hash: string) => void;
  /** 이 브랜치에 커밋 안 한 변경 파일 수 (지금 브랜치를 볼 때만) */
  pending: number;
  /** 풀 하다 충돌한 파일 수 (있으면 "커밋 전" 대신 "충돌"으로) */
  clash: number;
  onPending: () => void;
  busy: boolean;
  /** 갈라진 자리 칸을 누르면 그 브랜치로 옮긴다 */
  onJump: (branch: string) => void;
}) {
  const { items, fork } = history;
  const scroller = useRef<HTMLDivElement>(null);
  const newest = order === "new";

  // 순서를 바꾸면 방금 뒤집힌 맨 위가 보이게 한다
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [order, view]);

  if (items.length === 0 && pending === 0 && !fork) {
    return (
      <div className="clist-empty">
        {view === main ? (
          t("아직 커밋이 없어요.", "No commits yet.")
        ) : (
          <>
            <p>
              {t("아직 ", "No commits on ")}
              <b>{view}</b>
              {t("에서 한 커밋이 없어요.", " yet.")}
            </p>
            <p className="dim">{t("파일을 고치고 커밋하면 여기에 쌓여요.", "Change some files and commit — they'll show up here.")}</p>
          </>
        )}
      </div>
    );
  }

  const unpushedCount = items.filter((it) => it.stage === "unpushed").length;
  const remoteCount = items.filter((it) => it.stage === "remote").length;
  const rows = newest ? items : [...items].reverse();

  /** 커밋 전 / 충돌 자리 — 지금 하는 일이라 늘 "최신" 쪽 끝에 붙는다 */
  const head =
    clash > 0 ? (
        <button className={`crow pending clash ${selected === null ? "picked" : ""}`} onClick={onPending}>
          <span className="crow-tag">{t("충돌", "Conflict")}</span>
          <span className="crow-subject">{t(`고를 파일 ${clash}개`, `${clash} file(s) to resolve`)}</span>
          <span className="crow-meta">{t("다 고르면 합친 커밋이 여기에 쌓여요", "The merge commit will appear here")}</span>
        </button>
      ) : pending > 0 ? (
          <button
            className={`crow pending ${selected === null ? "picked" : ""}`}
            onClick={onPending}
            title={t("커밋 안 한 변경. 누르면 오른쪽에 파일 목록이 나와요", "Uncommitted changes. Click to see the files")}
          >
            <span className="crow-tag">{t("커밋 전", "Uncommitted")}</span>
            <span className="crow-subject">{t(`바뀐 파일 ${pending}개`, `${pending} changed file(s)`)}</span>
            <span className="crow-meta">
              {newest ? t("커밋하면 바로 아래에 한 칸 쌓여요", "Commit to add a box just below") : t("커밋하면 바로 위에 한 칸 쌓여요", "Commit to add a box just above")}
            </span>
          </button>
    ) : null;

  /** 갈라져 나온 자리 — 이 브랜치의 맨 처음이라 늘 "옛날" 쪽 끝에 붙는다 */
  const tail = fork ? (
    <button
      className="crow fork"
      disabled={!fork.exists || busy}
      onClick={() => onJump(fork.name)}
      title={
        fork.exists
          ? t(`누르면 '${fork.name}' 브랜치로 옮겨요`, `Click to switch to '${fork.name}'`)
          : t(`'${nameOf(fork.name)}' 브랜치는 지금은 없어요`, `'${nameOf(fork.name)}' no longer exists`)
      }
    >
      <span className="crow-tag">{t(`${nameOf(fork.name)}에서 갈라져 나옴`, `Branched from ${nameOf(fork.name)}`)}</span>
      <span className="crow-subject">
        {fork.commit.parents.length > 1 ? mergedText(mergedName(fork.commit.subject) ?? UNKNOWN) : fork.commit.subject}
      </span>
      <span className="crow-meta">
        {fork.exists ? t(`${fork.name}(으)로 옮기기 →`, `Switch to ${fork.name} →`) : t("지금은 없는 브랜치", "Branch no longer exists")}
      </span>
    </button>
  ) : null;

  return (
    <div className="clist" ref={scroller}>
      {newest ? head : tail}
      {rows.map((it, i) => {
        const c = it.commit;
        const prev = i === 0 ? null : rows[i - 1].stage;
        return (
          <div key={c.hash}>
            {it.stage !== prev && (
              <Divider
                stage={it.stage}
                first={i === 0}
                count={it.stage === "unpushed" ? unpushedCount : remoteCount}
              />
            )}
            <button
              className={`crow ${it.stage} ${c.hash === selected ? "picked" : ""}`}
              onClick={() => onSelect(c.hash)}
              title={`${c.subject}\n${c.author} · ${ago(c.date)}`}
            >
              <span className="crow-subject">
                {it.merged && <span className="crow-merge">{t("합침", "merge")}</span>}
                {it.merged ? mergedText(it.source) : c.subject}
              </span>
              <span className="crow-meta">
                <span className="crow-who">{c.author}</span>
                <span className="crow-when">{ago(c.date)}</span>
                <span className="crow-hash">{c.hash.slice(0, 7)}</span>
              </span>
            </button>
          </div>
        );
      })}

      {newest ? tail : head}
    </div>
  );
}

/**
 * 커밋 무더기를 가르는 줄. "여기부터는 아직 GitHub에 없어요" 처럼
 * 같은 처지의 커밋이 몇 개 쌓여 있는지를 한 줄로 알려준다.
 * 풀·푸시 버튼은 일부러 안 붙인다 — 윗줄과 하단 안내줄에 이미 있어서 세 곳이 된다 (2026-10-08)
 */
function Divider({ stage, first, count }: { stage: Stage; first: boolean; count: number }) {
  // 맨 위부터 이미 올라가 있으면 굳이 알릴 게 없다
  if (stage === "synced" && first) return null;

  if (stage === "remote")
    return (
      <div className="cdiv remote">
        <span className="cdiv-text">{t(`여기부터 GitHub에만 있어요 · ${count}개`, `On GitHub only from here · ${count}`)}</span>
      </div>
    );

  if (stage === "unpushed")
    return (
      <div className="cdiv unpushed">
        <span className="cdiv-text">{t(`여기부터 아직 GitHub에 없어요 · ${count}개`, `Not on GitHub yet from here · ${count}`)}</span>
      </div>
    );

  return (
    <div className="cdiv synced">
      <span className="cdiv-text">{t("여기부터 GitHub에도 있어요", "Also on GitHub from here")}</span>
    </div>
  );
}

/** from 브랜치(들)에는 있고 into 브랜치에는 없는 커밋 수. 브랜치 이름은 origin/… 도 같이 본다 */
export function missingCount(commits: Commit[], from: string, into: string): number {
  const tips = (name: string) =>
    [name, `origin/${name}`]
      .map((ref) => commits.find((c) => c.refs.includes(ref))?.hash)
      .filter((h): h is string => !!h);
  const have = reachable(commits, tips(into).slice(0, 1));
  let n = 0;
  for (const h of reachable(commits, tips(from))) if (!have.has(h)) n++;
  return n;
}

function reachable(commits: Commit[], tips: string[]): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length) {
    const h = queue.pop()!;
    if (!h || seen.has(h)) continue;
    seen.add(h);
    const c = byHash.get(h);
    if (c) queue.push(...c.parents);
  }
  return seen;
}

/** 합친 커밋 제목을 알아보기 쉬운 말로 */
function mergedText(source: string): string {
  return source
    ? t(`'${source}' 브랜치를 합쳤어요`, `Merged branch '${source}'`)
    : t("다른 브랜치를 합쳤어요", "Merged another branch");
}

const shortName = (p: string) => p.replace(/^origin\//, "");

/* ───────────── 합치는 중일 때의 왼쪽 화면 ─────────────
   보통 커밋 목록은 세로 한 줄이라, 나란한 두 갈래를 위아래로 놓게 된다.
   처음 보는 사람은 그걸 시간 순서로 읽어 버린다("내 쪽 다음에 팀원 쪽을 했구나").
   합치는 중은 Clickit에서 유일하게 진짜로 갈라지는 순간이라, 이때만 두 쪽을 가로로 놓는다. */

export interface MergeSides {
  /** 내 쪽에서만 한 커밋 (최신이 앞) */
  mine: Commit[];
  /** 합쳐 들어오는 쪽에서만 한 커밋 */
  incoming: Commit[];
  /** 갈라지기 전 공통 커밋 (갈라진 자리부터 몇 개) */
  common: Commit[];
}

/** 합치는 중인 두 갈래를 갈라진 자리 기준으로 나눈다 */
export function mergeSides(commits: Commit[], merge: MergeState): MergeSides {
  const before = merge.base ? reachable(commits, [merge.base]) : new Set<string>();
  const onlyAfter = (tip: string) => {
    if (!tip) return [];
    const from = reachable(commits, [tip]);
    return commits.filter((c) => from.has(c.hash) && !before.has(c.hash));
  };
  return {
    mine: onlyAfter(merge.head),
    incoming: onlyAfter(merge.incoming),
    common: commits.filter((c) => before.has(c.hash)).slice(0, 3),
  };
}

export function MergeView({
  sides,
  from,
  clash,
  base,
}: {
  sides: MergeSides;
  /** 합쳐 들어오는 쪽을 뭐라고 부를지 */
  from: string;
  /** 아직 고르지 않은 충돌 파일 수 */
  clash: number;
  /** 갈라진 자리를 찾았는지 */
  base: boolean;
}) {
  return (
    <div className="mergeview">
      {/* 아직 없는 커밋이라 점선. [합치기 마무리]를 누르면 여기에 생긴다 */}
      <div className={`mv-result ${clash === 0 ? "ready" : ""}`}>
        <span className="crow-tag">{t("합침 커밋", "Merge commit")}</span>
        <span className="crow-subject">
          {clash > 0
            ? t(`충돌한 파일 ${clash}개를 다 고르면 여기에 생겨요`, `Appears here once you resolve ${clash} file(s)`)
            : t("오른쪽 [합치기 마무리]를 누르면 여기에 생겨요", "Press [Finish merge] on the right and it appears here")}
        </span>
      </div>
      <p className="mv-join">{t("↑ 아래 두 갈래가 여기서 하나가 돼요", "↑ the two sides below become one here")}</p>

      <div className="mv-sides">
        <Side title={t(`내 쪽 · ${sides.mine.length}개`, `Mine · ${sides.mine.length}`)} kind="mine" commits={sides.mine} />
        <Side
          title={t(`합쳐 들어오는 쪽 · ${sides.incoming.length}개`, `Incoming · ${sides.incoming.length}`)}
          note={from}
          kind="theirs"
          commits={sides.incoming}
        />
      </div>

      {base ? (
        <>
          <p className="mv-join">{t("↓ 여기서 갈라졌어요", "↓ they split here")}</p>
          <div className="mv-common">
            {sides.common.map((c) => (
              <CommitBox key={c.hash} commit={c} />
            ))}
          </div>
        </>
      ) : (
        <p className="mv-join">{t("갈라진 자리를 찾지 못했어요", "Couldn't find where they split")}</p>
      )}
    </div>
  );
}

function Side({
  title,
  note,
  kind,
  commits,
}: {
  title: string;
  note?: string;
  kind: "mine" | "theirs";
  commits: Commit[];
}) {
  return (
    <div className={`mv-side ${kind}`}>
      <p className="mv-side-title">
        {title}
        {note && <span className="dim">{note}</span>}
      </p>
      {commits.length === 0 ? (
        <p className="mv-side-empty">{t("여기서 한 커밋은 없어요", "No commits on this side")}</p>
      ) : (
        commits.map((c) => <CommitBox key={c.hash} commit={c} />)
      )}
    </div>
  );
}

function CommitBox({ commit }: { commit: Commit }) {
  return (
    <div className="mv-commit" title={`${commit.subject}\n${commit.author} · ${ago(commit.date)}`}>
      <span className="crow-subject">{commit.subject}</span>
      <span className="crow-meta">
        <span>{commit.author}</span>
        <span>{ago(commit.date)}</span>
        <span className="crow-hash">{commit.hash.slice(0, 7)}</span>
      </span>
    </div>
  );
}
