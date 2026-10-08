# EasyGit

**git을 처음 쓰는 사람을 위한 VS Code 확장.**
커밋·푸시·풀·브랜치를 큰 창 하나에서 버튼으로 해요. 명령어를 외우지 않아도, 화면 맨 아래 안내줄이 지금 할 일과 그 버튼을 알려줘요.

[English below](#english)

## 이런 분께

- git 명령어가 무섭고, GitHub Desktop도 낯선 분
- 팀 프로젝트에서 "브랜치 따서 PR 올려 주세요"라는 말을 처음 들은 분
- 푸시를 했는데 GitHub에 왜 안 올라갔는지 모르겠는 분

## 할 수 있는 것

**시작하기**
- 폴더를 git 저장소로 만들기, GitHub 저장소 가져오기(클론)
- 내 프로젝트를 GitHub에 올리기 — 새 저장소를 만들거나, 미리 만들어 둔 빈 저장소에 연결
- 윗줄 `GitHub ↗` 를 누르면 저장소 페이지가 바로 열려요

**매일 쓰는 것**
- 바뀐 파일 체크 → 무엇을 바꿨는지 적고 → 커밋
- 푸시 / 풀 버튼에 올릴 커밋·받을 커밋 개수가 늘 같이 보여요
- 파일 하나의 변경 버리기 (새 파일은 휴지통으로 가서 다시 꺼낼 수 있어요)
- `node_modules`, `.env` 처럼 보통 안 올리는 파일은 알려주고, 처음부터 커밋에서 빼 둬요

**브랜치와 팀 작업**
- 브랜치 만들기·옮기기. 고치던 내용은 들고 가거나 잠시 치워 둘 수 있어요 (돌아오면 [다시 꺼내기])
- 브랜치별 커밋 목록 — 어디까지 GitHub에 올라갔는지 구분줄로 보여줘요
- 브랜치를 다 올렸으면 [PR 만들기 ↗]로 GitHub PR 작성 화면이 바로 열려요
- main의 최신 내용을 내 브랜치로 받아오기 (PR에 충돌이 났을 때)
- 충돌이 나면 파일마다 "내 거 / 팀원 거"를 나란히 보여주고 골라요

**실수했을 때**
- 아직 안 올린 커밋 취소하기 / 이미 올린 커밋은 되돌리는 커밋 만들기
- git 에러는 쉬운 말로 바꿔서 보여줘요 (원문은 [원문 보기]로)

**그 밖에**
- 한국어 / English
- 스킨: VS Code 테마를 따라가는 기본 / 픽셀 RPG

## 시작하기

1. 확장을 설치해요.
2. 왼쪽 막대의 EasyGit 아이콘 → **EasyGit 열기**. (또는 `Ctrl/⌘ + Shift + P` → "EasyGit 열기")
3. 그다음은 화면 맨 아래 안내줄을 따라가면 돼요.

GitHub에 올리거나 비공개 저장소를 가져올 때는 GitHub 로그인이 필요해요. 필요한 순간에 한 번만 물어봐요.

## 안심하고 쓰셔도 돼요

- GitHub 로그인은 VS Code에 들어 있는 GitHub 계정 기능을 그대로 써요. 비밀번호를 EasyGit이 받지 않아요.
- 로그인 토큰은 github.com에 접속할 때만 git에 넘기고, 파일이나 다른 곳에 저장하지 않아요.
- 푸시·되돌리기·변경 버리기처럼 되돌리기 어려운 일은 항상 확인창을 먼저 띄워요.
- 머지(합치기)는 일부러 넣지 않았어요. 팀원이 검토할 수 있게 GitHub의 PR에서 하는 걸 권해요.

## 설정

화면 오른쪽 위 톱니바퀴에서 바꿀 수 있어요.

| 설정 | 설명 |
|---|---|
| `easygit.language` | `auto`(VS Code 언어 따라감) / `ko` / `en` |
| `easygit.skin` | `vscode` / `pixel` |
| `easygit.warnOnMainBranch` | main에서 파일을 고치면 "이 브랜치 맞아요?" 물어보기 |
| `easygit.commitPrefixes` | 커밋 메시지 앞에 붙일 말머리 (`fix: ` 같은 것) |

## 피드백

버그나 "여기서 뭘 해야 할지 모르겠어요" 같은 의견은 [이슈](https://github.com/KimYeonBee/easygit/issues)에 남겨 주세요.
헷갈렸던 순간이 이 확장을 고치는 가장 좋은 재료예요.

## 개발

```bash
npm install
npm run build
```

VS Code에서 이 폴더를 열고 `F5` → 새로 뜬 창에서 아무 git 저장소 폴더를 열면 돼요.

---

## English

**A VS Code extension for people using git for the first time.**
Commit, push, pull and branch with buttons in one big window. A guide line at the bottom always tells you what to do next — with the button to do it.

**Features**
- Turn a folder into a repository, clone from GitHub, publish to a new GitHub repository or connect an empty one
- Commit checked files, push/pull with commit counts always shown, open the repository page with `GitHub ↗`
- Discard changes to a file (new files go to the trash), with a heads-up for files like `node_modules` or `.env`
- Create and switch branches, stash and restore changes, see what's already on GitHub in the commit list
- Open a pull request in one click, bring in the latest main, resolve conflicts by picking "mine" or "theirs"
- Undo unpushed commits, revert pushed ones, and read git errors in plain words
- Korean / English, default and pixel RPG skins

**Getting started**: install, click the EasyGit icon in the Activity Bar → **Open EasyGit**, then follow the bottom line.

Sign-in uses VS Code's built-in GitHub account. Your token is only passed to git when talking to github.com and is never stored by EasyGit.

## License

[MIT](LICENSE)
