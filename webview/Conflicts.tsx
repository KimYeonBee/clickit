import { useState } from "react";
import type { MergeState, FileChange } from "../src/gitService";
import { t } from "./i18n";

/**
 * 풀 하다가 충돌했을 때 오른쪽 칸 전체를 이 화면으로 바꾼다.
 * 파일마다 [내 거] [팀원 거] [직접 고치기] 중 하나를 고르고, 다 고르면 [합치기 마무리].
 */
export function Conflicts({
  merge,
  files,
  busy,
  send,
}: {
  merge: MergeState;
  files: FileChange[];
  busy: boolean;
  send: (m: unknown) => void;
}) {
  // [직접 고치기]를 누른 파일 — 그 뒤엔 [다 고쳤어요] 버튼을 보여준다
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const left = merge.conflicts.length;
  const autoMerged = files.filter((f) => f.label !== "conflict").length;
  const from = !merge.from
    ? t("들어오는 쪽", "the incoming side")
    : merge.fromRemote
      ? t(`GitHub의 ${merge.from}`, `${merge.from} on GitHub`)
      : merge.from;

  return (
    <div className="conflicts">
      <div className="conflict-head">
        <span className="mode-tag clash">{t("충돌", "Conflict")}</span>
        <div>
          <p className="conflict-title">
            {t("내 커밋과 ", "Your commits and ")}
            <b>{from}</b>
            {t("의 커밋이 같은 곳을 고쳤어요", " changed the same lines")}
          </p>
          <p className="dim">
            {t("파일마다 어느 쪽을 쓸지 골라 주세요. ", "Choose which version to keep for each file. ")}
            <b>{t("팀원 거", "Theirs")}</b> = {from}
          </p>
        </div>
      </div>

      {left === 0 ? (
        <div className="files-empty done">
          {t(
            "다 골랐어요. 아래 [합치기 마무리]를 누르면 합친 커밋이 만들어져요.",
            "All set. Press [Finish merge] below to create the merge commit."
          )}
        </div>
      ) : (
        <ul className="conflict-list">
          {merge.conflicts.map((c) => {
            const isEditing = editing.has(c.path);
            const deletedMine = !c.ours;
            const deletedTheirs = !c.theirs;
            // 충돌 표시가 하나도 없으면 이미 손으로 고쳐 둔 것이다.
            // [직접 고치기]를 이 화면에서 눌렀는지와 상관없이 마무리할 길을 열어 준다
            // (다른 편집기로 고쳤거나, 화면을 다시 연 뒤일 수 있다).
            const edited = c.ours && c.theirs && c.markers === 0;
            const canConfirm = isEditing || edited;
            return (
              <li key={c.path} className="conflict-card">
                <div className="conflict-file">
                  <span className="name">{c.path}</span>
                  {c.markers > 0 ? (
                    <span className="dim">{t(`고를 곳 ${c.markers}개`, `${c.markers} to resolve`)}</span>
                  ) : (
                    c.ours && c.theirs && <span className="dim">{t("직접 고침", "Edited by you")}</span>
                  )}
                  {c.ours && c.theirs && (
                    <button className="link" onClick={() => send({ type: "compareConflict", path: c.path })}>
                      {t("두 쪽 전체 비교", "Compare both")}
                    </button>
                  )}
                </div>

                {deletedMine || deletedTheirs ? (
                  <p className="conflict-note">
                    {deletedTheirs
                      ? t("팀원은 이 파일을 지웠고, 나는 고쳤어요.", "They deleted this file, and you changed it.")
                      : t("나는 이 파일을 지웠고, 팀원은 고쳤어요.", "You deleted this file, and they changed it.")}
                  </p>
                ) : (
                  c.hunks.map((h, i) => (
                    <div key={i} className="hunk">
                      <div className="side mine">
                        <span className="side-label">{t("내 거", "Mine")}</span>
                        <pre>{h.ours || t("(비어 있음)", "(empty)")}</pre>
                      </div>
                      <div className="side theirs">
                        <span className="side-label">{t("팀원 거", "Theirs")}</span>
                        <pre>{h.theirs || t("(비어 있음)", "(empty)")}</pre>
                      </div>
                    </div>
                  ))
                )}
                {c.markers > c.hunks.length && (
                  <p className="conflict-note">
                    {t(`…외 ${c.markers - c.hunks.length}곳 더`, `…and ${c.markers - c.hunks.length} more`)}
                  </p>
                )}

                <div className="conflict-actions">
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => send({ type: "resolveConflict", path: c.path, side: "ours" })}
                    title={
                      deletedMine
                        ? t("내가 한 대로 이 파일을 지워요", "Delete the file, as you did")
                        : t("이 파일을 전부 내 거로 정해요", "Use your version of the whole file")
                    }
                  >
                    {deletedMine ? t("내 거 (지우기)", "Mine (delete)") : t("내 거 쓰기", "Use mine")}
                  </button>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => send({ type: "resolveConflict", path: c.path, side: "theirs" })}
                    title={
                      deletedTheirs
                        ? t("팀원이 한 대로 이 파일을 지워요", "Delete the file, as they did")
                        : t("이 파일을 전부 팀원 거로 정해요", "Use their version of the whole file")
                    }
                  >
                    {deletedTheirs ? t("팀원 거 (지우기)", "Theirs (delete)") : t("팀원 거 쓰기", "Use theirs")}
                  </button>
                  {c.ours && c.theirs && !canConfirm && (
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(new Set(editing).add(c.path));
                        send({ type: "editConflict", path: c.path });
                      }}
                      title={t("두 쪽을 섞거나 새로 쓰고 싶을 때. 파일이 열려요", "To combine both or write something new. Opens the file")}
                    >
                      {t("직접 고치기", "Edit manually")}
                    </button>
                  )}
                  {canConfirm && (
                    <button
                      className="primary small"
                      disabled={busy}
                      onClick={() => send({ type: "markResolved", path: c.path })}
                      title={t(
                        "<<<<<<< 표시를 다 지웠는지 확인하고 해결됨으로 표시해요",
                        "Checks that no <<<<<<< markers remain, then marks it resolved"
                      )}
                    >
                      {t("다 고쳤어요", "Done editing")}
                    </button>
                  )}
                </div>
                {canConfirm && (
                  <p className="conflict-note">
                    {edited
                      ? t(
                          "이 파일엔 충돌 표시가 남아 있지 않아요. [다 고쳤어요]를 누르면 지금 파일에 쓰여 있는 내용 그대로 정해져요.",
                          "No conflict markers are left in this file. [Done editing] keeps exactly what's in the file now."
                        )
                      : t(
                          "열린 파일에서 충돌한 곳 위의 [현재 변경 사항 수락] / [수신 변경 사항 수락]을 누르거나, <<<<<<< 부터 >>>>>>> 까지를 통째로 지우고 새로 써도 돼요. 저장한 뒤 [다 고쳤어요]를 눌러요.",
                          "In the opened file, click [Accept Current Change] / [Accept Incoming Change] above each conflict — or delete everything from <<<<<<< to >>>>>>> and write your own. Save, then press [Done editing]."
                        )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="conflict-foot">
        <button className="link danger" disabled={busy} onClick={() => send({ type: "abortMerge" })}>
          {t("합치기 취소 (풀 하기 전으로)", "Cancel merge (go back)")}
        </button>
        <span className="spacer" />
        {autoMerged > 0 && (
          <span className="dim">
            {t(`충돌하지 않은 파일 ${autoMerged}개는 자동으로 합쳐졌어요`, `${autoMerged} other file(s) merged automatically`)}
          </span>
        )}
        <button className="primary" disabled={busy || left > 0} onClick={() => send({ type: "finishMerge" })}>
          {left > 0 ? t(`합치기 마무리 (${left}개 남음)`, `Finish merge (${left} left)`) : t("합치기 마무리", "Finish merge")}
        </button>
      </div>
    </div>
  );
}
