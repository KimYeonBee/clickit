import type { FileChange } from "../src/gitService";

/** .gitignore에 적을 한 줄과, 왜 보통 안 올리는지 */
export interface IgnoreHint {
  pattern: string;
  /** 비밀번호·키가 들어 있을 수 있는 파일 — 더 세게 말한다 */
  secret: boolean;
}

/**
 * 처음 쓰는 사람이 실수로 같이 올리기 쉬운 것들만 추렸다.
 * out/ 처럼 직접 만든 폴더 이름과 겹치기 쉬운 것은 넣지 않는다 (틀리게 안내하면 안 믿게 된다).
 */
const DIRS = ["node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".nuxt", ".idea", "coverage", ".gradle"];
const FILES = [".DS_Store", "Thumbs.db"];
const ENV_SAFE = /\.(example|sample|template|dist)$/i;

function hintFor(path: string): IgnoreHint | null {
  const segments = path.replace(/\/+$/, "").split("/");
  const isDir = path.endsWith("/");
  // 폴더 안의 파일이어도 경로 중간에 걸리면 그 폴더째로 안내한다
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dirSeg = i < segments.length - 1 || isDir;
    if (dirSeg && DIRS.includes(seg)) return { pattern: `${seg}/`, secret: false };
  }
  const name = segments[segments.length - 1];
  if (isDir) return null;
  if (FILES.includes(name)) return { pattern: name, secret: false };
  if ((name === ".env" || name.startsWith(".env.")) && !ENV_SAFE.test(name)) return { pattern: name, secret: true };
  if (name.endsWith(".pyc")) return { pattern: "*.pyc", secret: false };
  if (name.endsWith(".log")) return { pattern: "*.log", secret: false };
  return null;
}

/** 새로 생긴 파일 중 .gitignore에 넣기를 권할 것들. 사용자가 "그냥 둘래요" 한 줄은 뺀다 */
export function ignoreHints(files: FileChange[], dismissed: string[]): { hints: IgnoreHint[]; paths: Set<string> } {
  const hints = new Map<string, IgnoreHint>();
  const paths = new Set<string>();
  for (const f of files) {
    if (!f.untracked) continue;
    const h = hintFor(f.path);
    if (!h || dismissed.includes(h.pattern)) continue;
    hints.set(h.pattern, h);
    paths.add(f.path);
  }
  return { hints: [...hints.values()], paths };
}
