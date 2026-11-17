// FoundryVTT本体の起動とログイン。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  compose,
  composeRunning,
  dockerReachable,
  ensureWorld,
  findCompose,
  zipPath,
} from "../../../tools/foundry-compose.mjs";
import { DEV_DATA, FOUNDRY_APP, ORIGIN, PORT, USER, WORLD } from "./config.mjs";

/**
 * 前提が整っているかを先に見る。
 *
 * 足りないまま進むと、Chromeのタイムアウトなど遠い場所で失敗して原因が分からなくなる。
 */
export function preflight() {
  const problems = FOUNDRY_APP ? nativeProblems() : composeProblems();
  if (PORT === 30000) {
    problems.push("FVTT_PORT が 30000。メイン環境のポートなので使わない");
  }
  if (problems.length > 0) {
    console.error(`実機検証の前提が整っていない:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
}

function nativeProblems() {
  const problems = [];
  if (!existsSync(join(FOUNDRY_APP, "main.mjs"))) {
    problems.push(`FOUNDRY_APP に main.mjs が無い: ${FOUNDRY_APP}`);
  }
  if (!DEV_DATA) {
    problems.push("FOUNDRY_APP を指定したときは FVTT_DEV_DATA も要る");
    return problems;
  }
  if (!existsSync(DEV_DATA)) {
    problems.push(`FVTT_DEV_DATA が無い: ${DEV_DATA}`);
  }
  if (!existsSync(join(DEV_DATA, "Data/worlds", WORLD))) {
    problems.push(`ワールドが無い: ${join(DEV_DATA, "Data/worlds", WORLD)}`);
  }
  if (!existsSync(join(DEV_DATA, "Data/systems/emoklore"))) {
    problems.push(
      `システムが配置されていない: ${join(DEV_DATA, "Data/systems/emoklore")}\n` +
        `    リポジトリの dist/ へのsymlinkを張る`,
    );
  }
  return problems;
}

/**
 * コンテナで動かすときの前提。ワールドとシステムの配置は見ない
 * （ワールドは無ければ起動時に作り、システムは compose.yaml が dist/ をマウントする）。
 */
function composeProblems() {
  const problems = [];
  if (!findCompose()) {
    problems.push(
      "docker compose が無い。Dockerを入れるか、FOUNDRY_APP で本体を直接指す（docs/testing.md）",
    );
    return problems;
  }
  if (!dockerReachable()) {
    problems.push("Dockerに接続できない。デーモン（colima start など）を起動する");
  }
  // 展開済みならzipは要らない。どちらも無いときだけ、置き場所を伝える
  const installed = existsSync(join(DEV_DATA, "Config/options.json"));
  if (!installed && !existsSync(zipPath())) {
    problems.push(`本体のzipが無い: ${zipPath()}\n    Node配布版をこの名前で置く`);
  }
  return problems;
}

export function build() {
  const result = spawnSync("npm", ["run", "build"], {
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(result.stdout ?? "", result.stderr ?? "");
    console.error("ビルドに失敗したので検証を中止する");
    process.exit(1);
  }
}

export async function startFoundry() {
  return FOUNDRY_APP ? startNative() : startCompose();
}

async function startNative() {
  const child = spawn(
    process.execPath,
    [join(FOUNDRY_APP, "main.mjs"), `--dataPath=${DEV_DATA}`, `--port=${PORT}`, `--world=${WORLD}`],
    { stdio: "ignore" },
  );

  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(ORIGIN, { redirect: "manual" });
      if (res.status < 500) return child;
    } catch {
      // まだ上がっていない
    }
    if (child.exitCode !== null) {
      throw new Error(`Foundryが起動直後に終了した（exit ${child.exitCode}）`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`Foundryが${PORT}で応答しない`);
}

/**
 * コンテナを作り直して起動する。
 *
 * **動いていても作り直す。** 本体は system.json とテンプレートを起動時に読むので、
 * ビルドし直した dist/ を確実に見せるには再起動が要る。直接起動が毎回プロセスを
 * 立て直すのと同じ扱いにしてある。
 *
 * 後始末は「自分が起こしたなら止める」。開発中に上げてあったコンテナは残す。
 */
async function startCompose() {
  const wasRunning = composeRunning();
  ensureWorld(WORLD);
  const up = compose(["up", "-d", "--force-recreate"], {
    env: { ...process.env, FVTT_PORT: String(PORT), FVTT_WORLD: WORLD },
  });
  if (up.status !== 0) {
    throw new Error(`docker compose up に失敗した:\n${up.stderr || up.stdout}`);
  }
  const handle = {
    kill: () => {
      if (!wasRunning) compose(["stop"]);
    },
  };

  // 初回はzipの展開が入るので長めに待つ。ワールドが開くと / は /join へ飛ぶ
  let location = "";
  for (let i = 0; i < 600; i++) {
    try {
      const res = await fetch(ORIGIN, { redirect: "manual" });
      location = res.headers.get("location") ?? "";
      if (location.endsWith("/join")) return handle;
      if (location.endsWith("/license")) break;
    } catch {
      // まだ上がっていない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  handle.kill();
  if (location.endsWith("/license")) {
    throw new Error(
      `ライセンスが未署名。${ORIGIN} を開いてEULAに同意する` +
        "（キーは .env の FOUNDRY_LICENSE_KEY。docs/testing.md）",
    );
  }
  throw new Error(
    `ワールド ${WORLD} が開かない（最後の転送先: ${location || "応答なし"}）。` +
      "docker compose logs foundry を見る",
  );
}

export async function joinAsUser(page) {
  await page.nav(`${ORIGIN}/join`);

  // ユーザー選択の欄はビルドで形が変わる。14.366 は <input name=username> の自由入力
  // （typeahead。候補はDOMに載らない）、14.370 は <select name=userId> の一覧に戻った。
  // 両方を受ける。自由入力では実在しない名前も即座には弾かれず、game.ready に
  // ならないまま下のループが尽きる形になる
  const filled = await page.eval((name) => {
    const select = document.querySelector("select[name=userId]");
    const input = document.querySelector("input[name=username]");
    if (select) {
      const option = [...select.options].find((o) => o.textContent.trim() === name);
      if (!option) return "no-user";
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (input) {
      input.value = name;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return "no-field";
    }
    document.querySelector("button[name=join]").click();
    return "ok";
  }, USER);
  if (filled === "no-field") throw new Error("joinページにユーザーの選択欄が無い");
  if (filled === "no-user") throw new Error(`joinページの一覧に ${USER} がいない`);

  for (let i = 0; i < 200; i++) {
    if (await page.eval(() => globalThis.game?.ready === true)) return USER;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${USER} でログインできない（その名前のユーザーが無いか、アクセスキーが要る）`);
}
