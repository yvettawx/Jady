// Downloads the fonts listed in fonts.json into public/fonts/ and checks each SHA-256.
// Files already there with the right hash are kept, so only the first run needs the network.
// Run with `pnpm run fonts`; `pnpm dev` and `pnpm build` run it first. Entries marked devOnly
// go to .dev-fonts/, which only the dev server serves; `--release` (pnpm build) skips them.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface Entry {
  file: string;
  url: string;
  bytes: number;
  sha256: string;
  devOnly?: boolean;
}

const root = new URL("../", import.meta.url);
const release = process.argv.includes("--release");
const { files: all } = JSON.parse(readFileSync(new URL("fonts.json", root), "utf8")) as {
  files: Entry[];
};
const files = all.filter((e) => !(release && e.devOnly));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function cached(path: URL, e: Entry): boolean {
  try {
    return sha256(readFileSync(path)) === e.sha256;
  } catch {
    return false;
  }
}

/** fetch() hides the network error (ENOTFOUND, ECONNREFUSED…) a couple of levels down. */
function reason(err: unknown): string {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  return cause?.code ?? cause?.errors?.[0]?.code ?? (err as Error).message;
}

async function fetchOne(e: Entry): Promise<string | null> {
  const path = new URL(`${e.devOnly ? ".dev-fonts" : "public/fonts"}/${e.file}`, root);
  if (cached(path, e)) return null;
  let body: Uint8Array;
  try {
    const res = await fetch(e.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new Error(
      `could not download ${e.file} from ${e.url}: ${reason(err)}\n` +
        "  The fonts need the network once; after that the copies in public/fonts/ are used.",
      { cause: err },
    );
  }
  if (body.length !== e.bytes || sha256(body) !== e.sha256) {
    throw new Error(
      `${e.file} does not match fonts.json (got ${body.length} bytes, sha256 ${sha256(body)}); not saved`,
    );
  }
  // URL-based paths: `path.pathname` would be "/C:/…" on Windows.
  mkdirSync(new URL("./", path), { recursive: true });
  // Write next to the target and rename, so an interrupted run never leaves half a font.
  const tmp = new URL(`${path.href}.part`);
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return e.file;
}

const results = await Promise.allSettled(files.map(fetchOne));
const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
for (const r of failed) console.error(`fonts: ${(r.reason as Error).message}`);
if (failed.length) process.exit(1);
const fetched = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
console.log(
  fetched.length
    ? `fonts: downloaded ${fetched.join(", ")}`
    : `fonts: ${files.length} files up to date`,
);
