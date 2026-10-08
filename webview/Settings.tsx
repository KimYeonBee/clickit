import { useEffect, useState } from "react";
import { Lang, t } from "./i18n";

export interface SettingsData {
  account: string | null;
  identity: { name: string; email: string };
  skin: string;
  prefixes: string[];
  defaultPrefixes: string[];
  warnOnMainBranch: boolean;
  /** 이 저장소의 내 브랜치 이름들 (고정할 후보) */
  branches: string[];
  /** 윗줄에 고정해 둔 브랜치 이름들 */
  pinned: string[];
  sponsorUrl: string | null;
  language: Lang;
}

/** "fix" → "fix: ", "[FE]" → "[FE] " — 사람들이 보통 쓰는 말머리 모양으로 맞춘다 */
export function normalizePrefix(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/[\p{L}\p{N}]$/u.test(v)) return `${v}: `;
  return `${v} `;
}

export function Settings({
  data,
  send,
  onClose,
}: {
  data: SettingsData;
  send: (m: unknown) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(data.identity.name);
  const [email, setEmail] = useState(data.identity.email);
  const [newPrefix, setNewPrefix] = useState("");

  // 저장하고 나서 확장이 돌려준 값으로 칸을 맞춘다
  useEffect(() => {
    setName(data.identity.name);
    setEmail(data.identity.email);
  }, [data.identity.name, data.identity.email]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const skins = [
    { id: "vscode", name: t("기본", "Default"), desc: t("VS Code 테마 색을 그대로 따라가요", "Follows your VS Code theme") },
    { id: "pixel", name: t("픽셀 RPG", "Pixel RPG"), desc: t("옛날 게임기 같은 각진 화면", "Blocky, retro game look") },
  ];
  const languages: { id: Lang; name: string }[] = [
    { id: "ko", name: "한국어" },
    { id: "en", name: "English" },
  ];

  const togglePin = (branch: string) =>
    send({
      type: "setPinnedBranches",
      branches: data.pinned.includes(branch) ? data.pinned.filter((b) => b !== branch) : [...data.pinned, branch],
    });
  // 고정해 뒀는데 그 사이 지워진 브랜치 (이름만 남아 윗줄에는 안 나온다)
  const gone = data.pinned.filter((b) => !data.branches.includes(b));

  const identityChanged = name.trim() !== data.identity.name || email.trim() !== data.identity.email;
  const emailOk = /^[^\s@]+@[^\s@]+$/.test(email.trim());
  const canSaveIdentity = identityChanged && name.trim() !== "" && emailOk;

  const prefix = normalizePrefix(newPrefix);
  const addPrefix = () => {
    if (!prefix || data.prefixes.includes(prefix)) return;
    send({ type: "setPrefixes", prefixes: [...data.prefixes, prefix] });
    setNewPrefix("");
  };
  const sameAsDefault =
    data.prefixes.length === data.defaultPrefixes.length && data.prefixes.every((p, i) => p === data.defaultPrefixes[i]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={t("EasyGit 설정", "EasyGit settings")}>
        <header className="modal-head">
          <h1>{t("설정", "Settings")}</h1>
          <button className="icon-btn" onClick={onClose} aria-label={t("닫기", "Close")} title={t("닫기 (Esc)", "Close (Esc)")}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <section className="set">
          <h2>{t("계정", "Account")}</h2>
          <div className="set-row">
            <div className="set-label">
              GitHub
              <span className="dim">{t("푸시·풀·저장소 가져오기에 쓰여요", "Used for push, pull and cloning")}</span>
            </div>
            {data.account ? (
              <div className="set-value">
                <span className="account">
                  <span className="account-dot" />
                  {data.account}
                </span>
                <button className="ghost" onClick={() => send({ type: "switchAccount" })}>
                  {t("다른 계정으로 바꾸기", "Switch account")}
                </button>
              </div>
            ) : (
              <div className="set-value">
                <span className="dim">{t("로그인 안 함", "Not signed in")}</span>
                <button className="primary small" onClick={() => send({ type: "login" })}>
                  {t("GitHub 로그인", "Sign in to GitHub")}
                </button>
              </div>
            )}
          </div>
          {data.account && (
            <p className="set-hint">
              {t(
                "로그아웃은 VS Code 왼쪽 아래 사람 모양(계정) 메뉴에서 할 수 있어요.",
                "To sign out, use the Accounts menu (person icon) at the bottom left of VS Code."
              )}
            </p>
          )}

          <div className="set-row">
            <div className="set-label">
              {t("다른 저장소 가져오기", "Clone another repository")}
              <span className="dim">{t("GitHub에 있는 저장소를 새 폴더로 복사해 와요", "Copies a GitHub repository into a new folder")}</span>
            </div>
            <button className="ghost" onClick={() => send({ type: "clone" })}>
              {t("GitHub 저장소 가져오기", "Clone from GitHub")}
            </button>
          </div>

          <div className="set-row column">
            <div className="set-label">
              {t("커밋에 남는 이름·이메일", "Name & email on commits")}
              <span className="dim">
                {t(
                  "커밋마다 누가 했는지 남아요. GitHub 계정 이메일이어야 내 커밋으로 잡혀요",
                  "Recorded on every commit. Use your GitHub email so commits are linked to you"
                )}
              </span>
            </div>
            <div className="identity">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("이름 (예: 김연비)", "Name (e.g. Alex Kim)")} />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("이메일 (예: me@example.com)", "Email (e.g. me@example.com)")}
              />
              <button
                className="primary small"
                disabled={!canSaveIdentity}
                onClick={() => send({ type: "setIdentity", name, email })}
              >
                {t("저장", "Save")}
              </button>
            </div>
            {email.trim() !== "" && !emailOk && (
              <p className="set-hint warn">{t("이메일 모양이 아니에요.", "That doesn't look like an email.")}</p>
            )}
          </div>
        </section>

        <section className="set">
          <h2>{t("언어", "Language")}</h2>
          <div className="lang-switch" role="radiogroup" aria-label={t("언어", "Language")}>
            {languages.map((l) => (
              <button
                key={l.id}
                role="radio"
                aria-checked={data.language === l.id}
                className={`lang-btn ${data.language === l.id ? "on" : ""}`}
                onClick={() => send({ type: "setLanguage", language: l.id })}
              >
                {l.name}
              </button>
            ))}
          </div>
        </section>

        <section className="set">
          <h2>{t("스킨", "Skin")}</h2>
          <div className="skins">
            {skins.map((s) => (
              <button
                key={s.id}
                className={`skin-card ${data.skin === s.id ? "on" : ""}`}
                onClick={() => send({ type: "setSkin", skin: s.id })}
              >
                <span className={`skin-preview ${s.id}`} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>{s.name}</strong>
                <span className="dim">{s.desc}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="set">
          <h2>
            {t("말머리", "Commit prefixes")}
            <span className="dim">
              {t("커밋 칸 옆 [말머리 붙이기]에 나오는 목록이에요", "Shown in the [Add prefix] menu next to the commit box")}
            </span>
          </h2>
          <div className="prefix-list">
            {data.prefixes.length === 0 && (
              <span className="dim">
                {t("비어 있어요. 비워 두면 [말머리 붙이기]가 안 보여요.", "Empty. The [Add prefix] menu is hidden when empty.")}
              </span>
            )}
            {data.prefixes.map((p) => (
              <span key={p} className="prefix-chip">
                {p.trim()}
                <button
                  onClick={() => send({ type: "setPrefixes", prefixes: data.prefixes.filter((x) => x !== p) })}
                  aria-label={t(`${p.trim()} 지우기`, `Remove ${p.trim()}`)}
                  title={t("지우기", "Remove")}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="prefix-add">
            <input
              value={newPrefix}
              onChange={(e) => setNewPrefix(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPrefix()}
              placeholder={t("새 말머리 (예: hotfix, [FE])", "New prefix (e.g. hotfix, [FE])")}
            />
            <button className="ghost" disabled={!prefix || data.prefixes.includes(prefix)} onClick={addPrefix}>
              {t("추가", "Add")}
            </button>
            {!sameAsDefault && (
              <button className="link" onClick={() => send({ type: "setPrefixes", prefixes: data.defaultPrefixes })}>
                {t("기본값으로", "Reset to default")}
              </button>
            )}
          </div>
          {prefix && (
            <p className="set-hint">
              {t(`추가하면 커밋 메시지 앞에 "${prefix}"로 붙어요.`, `It will be added to the start of the message as "${prefix}".`)}
            </p>
          )}
        </section>

        <section className="set">
          <h2>
            {t("고정 브랜치", "Pinned branches")}
            <span className="dim">
              {t("윗줄 [내 컴퓨터]에 버튼으로 늘 보여요", "Always shown as buttons under [Your computer]")}
            </span>
          </h2>
          {data.branches.length === 0 ? (
            <span className="dim">{t("내 컴퓨터에 브랜치가 없어요.", "No branches on your computer.")}</span>
          ) : (
            <div className="prefix-list">
              {data.branches.map((b) => (
                <button
                  key={b}
                  className={`chip ${data.pinned.includes(b) ? "on" : ""}`}
                  aria-pressed={data.pinned.includes(b)}
                  onClick={() => togglePin(b)}
                  title={t("누르면 고정 / 고정 해제", "Click to pin or unpin")}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
          <p className="set-hint">
            {t(
              "고정해 두면 메인 브랜치처럼 눌러서 그 브랜치의 커밋 목록을 바로 볼 수 있어요. 브랜치를 옮기는 건 아니에요.",
              "A pinned branch gets a button like Main branch, to view its commits in one click. It doesn't switch branches."
            )}
          </p>
          {gone.length > 0 && (
            <p className="set-hint warn">
              {t(`지금은 없는 브랜치가 고정돼 있어요: ${gone.join(", ")}`, `Pinned branches that no longer exist: ${gone.join(", ")}`)}{" "}
              <button className="link" onClick={() => send({ type: "setPinnedBranches", branches: data.pinned.filter((b) => data.branches.includes(b)) })}>
                {t("정리하기", "Clean up")}
              </button>
            </p>
          )}
        </section>

        <section className="set">
          <h2>{t("알림", "Notifications")}</h2>
          <label className="set-row toggle">
            <div className="set-label">
              {t("main 브랜치에서 저장하면 물어보기", "Ask when saving on main")}
              <span className="dim">{t('"이 브랜치에서 하는 게 맞나요?" 알림', '"Is this the right branch?" prompt')}</span>
            </div>
            <input
              type="checkbox"
              checked={data.warnOnMainBranch}
              onChange={(e) => send({ type: "setWarnOnMain", value: e.target.checked })}
            />
          </label>
        </section>

        {data.sponsorUrl && (
          <section className="set sponsor">
            <div className="set-label">
              {t("EasyGit이 도움이 됐나요?", "Is EasyGit helping you?")}
              <span className="dim">
                {t("EasyGit은 무료예요. 후원은 계속 만드는 데 큰 힘이 돼요.", "EasyGit is free. Sponsoring helps keep it going.")}
              </span>
            </div>
            <button className="ghost sponsor-btn" onClick={() => send({ type: "openSponsor" })}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.3 5 6.8 5c2 0 3.4 1.1 4.2 2.3h2C13.8 6.1 15.2 5 17.2 5c3.5 0 5.6 3.6 4.3 6.8C19.5 16.4 12 21 12 21z" />
              </svg>
              {t("후원하기", "Sponsor")}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
