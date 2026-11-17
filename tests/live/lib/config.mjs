// 実機検証の設定。各自の配置は環境変数で指す。
//
// 本体の動かし方は2通りで、FOUNDRY_APP の有無で決まる。
//   未指定 … compose.yaml のコンテナを使う（既定）。dataPath は .foundry/data に固定
//   指定   … その場所のNode配布版を直接起動する。FVTT_DEV_DATA も要る
//
//   FOUNDRY_APP   … 本体のNode配布版（main.mjs のあるディレクトリ）。直接起動するときだけ
//   FVTT_DEV_DATA … 直接起動のときの検証専用dataPath。**メイン環境のデータを指さないこと**
//   FVTT_PORT     … 既定 30014（300 + 世代番号。30000はメイン環境なので使わない）
//   FVTT_WORLD    … 既定 emoklore-test
//   FVTT_USER     … ログインするユーザー名。既定 Gamemaster
//   SKIP_BUILD    … 1 ならビルドを省く
//   CHROME_BIN / CDP_PORT … lib/cdp.mjs 参照
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPOSE_DATA } from "../../../tools/foundry-compose.mjs";

/**
 * リポジトリルートの `.env` を読む（無ければ何もしない）。雛形は `.env.example`。
 *
 * Nodeの `--env-file-if-exists` は 22.9 以降でしか使えず、ファイルが無いと
 * 標準エラーに通知を出す。既定値で足りる人のほうが多いので、黙って読む。
 * 扱うのはパス・ポート・名前だけなので、`KEY=VALUE` と `#` コメントで足りる。
 *
 * **すでにある環境変数を上書きしない。** `FVTT_PORT=30015 npm run verify:live`
 * のような一時的な指定が、`.env` に負けると驚く。
 */
const loadEnvFile = () => {
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.trim().replace(/^["'](.*)["']$/, "$1");
  }
};

loadEnvFile();

/** 直接起動する本体の場所。null ならコンテナを使う */
export const FOUNDRY_APP = process.env.FOUNDRY_APP || null;
/** 直接起動で FVTT_DEV_DATA が無いときは null（前提確認で弾く）。コンテナでは固定 */
export const DEV_DATA = FOUNDRY_APP ? process.env.FVTT_DEV_DATA || null : COMPOSE_DATA;
export const PORT = Number(process.env.FVTT_PORT ?? 30014);
export const WORLD = process.env.FVTT_WORLD ?? "emoklore-test";
export const USER = process.env.FVTT_USER ?? "Gamemaster";
export const ORIGIN = `http://localhost:${PORT}`;

/** 検証用に作るものの印。後片付けでこれを頼りに消す */
export const TAG = "__verify";

/**
 * スクリーンショット採取用に作るものの印（`npm run shots:live`）。
 *
 * **名前ではなくフラグで印を付ける。** 採取の目的は書体と幅の判断なので、
 * `__verify_` のような接頭辞が名前に混ざると、いちばん見たいもの（キャラクター名の
 * 伸縮、技能名の折り返し、印の並び）が歪む。
 *
 * 検証（`TAG`）と印を分けてあるのは、どちらかが途中で落ちて残骸が出たとき、
 * もう片方を巻き込まないため。
 */
export const SHOT_FLAG = { scope: "emoklore", key: "shotFixture" };

/** 取り込みの検証でアクター名がこれに変わる。後片付けで拾うために名前を共有する */
export const IMPORTED_NAME = "パラム無し";
