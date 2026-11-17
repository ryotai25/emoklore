// compose.yaml のFoundry本体を扱う道具。`npm run foundry:up` などの入口と、
// 実機検証（tests/live/lib/foundry.mjs）の両方から使う。
//
//   node tools/foundry-compose.mjs up      ワールドを用意して起動する
//   node tools/foundry-compose.mjs down    止める
//   node tools/foundry-compose.mjs types   zipから client/ と common/ を foundry/ に展開する
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** compose.yaml がマウントするdataPath。検証専用で、git管理外 */
export const COMPOSE_DATA = join(ROOT, ".foundry/data");

const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", ...options });

let composeCommand;
/**
 * `docker compose`（プラグイン）と `docker-compose`（単体）のうち、使えるほうを返す。
 *
 * Homebrewの `docker` はプラグインを自動では見つけないので、`docker-compose` だけが
 * 通る環境がある。どちらも無ければ null。
 */
export const findCompose = () => {
  if (composeCommand !== undefined) return composeCommand;
  if (run("docker", ["compose", "version"]).status === 0) composeCommand = ["docker", "compose"];
  else if (run("docker-compose", ["version"]).status === 0) composeCommand = ["docker-compose"];
  else composeCommand = null;
  return composeCommand;
};

export const compose = (args, options = {}) => {
  const command = findCompose();
  if (!command) throw new Error("docker compose が見つからない");
  return run(command[0], [...command.slice(1), ...args], options);
};

export const dockerReachable = () => run("docker", ["info"]).status === 0;

export const composeRunning = () =>
  compose(["ps", "--status", "running", "--quiet", "foundry"]).stdout.trim() !== "";

/** compose.yaml の FOUNDRY_VERSION（例: "14.370"） */
export const foundryVersion = () => {
  const text = readFileSync(join(ROOT, "compose.yaml"), "utf-8");
  const version = text.match(/^\s*FOUNDRY_VERSION:\s*"?([\d.]+)"?\s*$/m)?.[1];
  if (!version) throw new Error("compose.yaml に FOUNDRY_VERSION が無い");
  return version;
};

export const zipPath = () => {
  const cache = (process.env.FOUNDRY_CACHE ?? "~/.cache/foundry").replace(/^~(?=\/|$)/, homedir());
  return join(cache, `foundryvtt-${foundryVersion()}.zip`);
};

/**
 * 検証用ワールドが無ければ world.json だけを置く。データベースは初回起動時に本体が作る。
 *
 * `compatibility.verified` を世代（"14"）で書くのが要点。ビルド単位（"14.370"）で書くと、
 * 本体を上げるたびに `World#canAutoLaunch` が偽になり、FOUNDRY_WORLD を指定しても開かない。
 */
export const ensureWorld = (world) => {
  const dir = join(COMPOSE_DATA, "Data/worlds", world);
  const file = join(dir, "world.json");
  if (existsSync(file)) return false;
  const generation = foundryVersion().split(".")[0];
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        id: world,
        title: world,
        system: "emoklore",
        coreVersion: foundryVersion(),
        compatibility: { minimum: generation, verified: generation },
        description: "",
      },
      null,
      2,
    )}\n`,
  );
  return true;
};

/** dist/ が無いままマウントすると、Dockerが空のディレクトリを作ってシステムが見つからなくなる */
export const distBuilt = () => existsSync(join(ROOT, "dist/system.json"));

const extractTypes = () => {
  const zip = zipPath();
  if (!existsSync(zip)) {
    console.error(`本体のzipが無い: ${zip}`);
    process.exit(1);
  }
  mkdirSync(join(ROOT, "foundry"), { recursive: true });
  for (const dir of ["client", "common"]) {
    // 以前の `npm run link:foundry` が張ったsymlinkが残っていると、unzipがリンク先の
    // 本体インストールを上書きする。リンクだけを外す
    const path = join(ROOT, "foundry", dir);
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const unzip = run("unzip", ["-q", "-o", zip, "client/*", "common/*", "-d", "foundry"], {
    stdio: "inherit",
  });
  if (unzip.status !== 0) process.exit(unzip.status ?? 1);
  console.log(`foundry/ に ${foundryVersion()} の client/ と common/ を展開した`);
};

const main = () => {
  const [action] = process.argv.slice(2);
  switch (action) {
    case "up": {
      if (!distBuilt()) {
        console.error("dist/ が無い。先に npm run build を実行する");
        process.exit(1);
      }
      const world = process.env.FVTT_WORLD ?? "emoklore-test";
      if (ensureWorld(world)) console.log(`ワールド ${world} を作った`);
      const result = compose(["up", "-d"], { stdio: "inherit" });
      process.exit(result.status ?? 1);
      break;
    }
    case "down": {
      const result = compose(["down"], { stdio: "inherit" });
      process.exit(result.status ?? 1);
      break;
    }
    case "types":
      extractTypes();
      break;
    default:
      console.error("使い方: node tools/foundry-compose.mjs <up|down|types>");
      process.exit(1);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
