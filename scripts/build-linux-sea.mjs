import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The Linux SEA release must be built on linux-x64");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const deployedServer = resolve(process.argv[2] ?? "");
const releaseDirectory = resolve(
  process.argv[3] ?? resolve(repositoryRoot, "release", "Ygdria-linux-x64"),
);
const buildDirectory = resolve(repositoryRoot, "release", ".linux-sea-build");
const bundledEntry = resolve(buildDirectory, "ygdria-server.cjs");
const seaBlob = resolve(buildDirectory, "ygdria-server.blob");
const seaConfig = resolve(buildDirectory, "sea-config.json");
const executable = resolve(releaseDirectory, "ygdria-server");
const postject = resolve(repositoryRoot, "node_modules", ".bin", "postject");

if (!process.argv[2]) {
  throw new Error(
    "Usage: node scripts/build-linux-sea.mjs <deployed-server-dir> [release-dir]",
  );
}

rmSync(buildDirectory, { recursive: true, force: true });
rmSync(releaseDirectory, { recursive: true, force: true });
mkdirSync(buildDirectory, { recursive: true });
mkdirSync(releaseDirectory, { recursive: true });

const externalNativeModule = {
  name: "external-native-module",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      // Load the package from the release's native sidecar. Its default
      // binding loader supports both prebuilds/linux-x64.node and a
      // node-gyp build/Release/better_sqlite3.node produced by CI.
      path: "better-sqlite3",
      namespace: "ygdria-native",
    }));
    esbuild.onLoad(
      { filter: /.*/, namespace: "ygdria-native" },
      ({ path }) => ({
        contents: `module.exports = globalThis.__ygdriaExternalRequire(${JSON.stringify(path)});`,
        loader: "js",
      }),
    );
  },
};

await build({
  entryPoints: [resolve(repositoryRoot, "apps", "server", "src", "index.ts")],
  outfile: bundledEntry,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  sourcemap: false,
  minify: false,
  plugins: [externalNativeModule],
  // The normal ESM server uses import.meta.dirname as its development
  // fallback. SEA always injects YGDRIA_BUNDLED_WEB_DIST, so that fallback is
  // unreachable and can be removed from this CJS bundle.
  define: { "import.meta.dirname": "undefined" },
  banner: {
    js: [
      "globalThis.__ygdriaExternalRequire = require('node:module').createRequire(",
      "  require('node:path').join(require('node:path').dirname(process.execPath), 'native', 'package.json')",
      ");",
      "process.env.YGDRIA_BUNDLED_WEB_DIST = require('node:path').join(",
      "  require('node:path').dirname(process.execPath), 'web', 'dist'",
      ");",
    ].join("\n"),
  },
});

writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundledEntry,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], {
  stdio: "inherit",
});
copyFileSync(process.execPath, executable);
execFileSync(
  postject,
  [
    executable,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" },
);
chmodSync(executable, 0o755);

const nativeRoot = resolve(releaseDirectory, "native");
const betterSqliteCandidates = [
  resolve(deployedServer, "node_modules", "better-sqlite3"),
  resolve(
    deployedServer,
    "node_modules",
    "@ygdria",
    "database",
    "node_modules",
    "better-sqlite3",
  ),
  resolve(
    repositoryRoot,
    "packages",
    "database",
    "node_modules",
    "better-sqlite3",
  ),
];
const betterSqliteRuntime = betterSqliteCandidates
  .map((packageDirectory) => ({
    packageDirectory,
    nativeAddons: [
      resolve(packageDirectory, "prebuilds", "linux-x64.node"),
      resolve(
        packageDirectory,
        "build",
        "Release",
        "better_sqlite3.node",
      ),
    ],
  }))
  .find(
    ({ packageDirectory, nativeAddons }) =>
      existsSync(resolve(packageDirectory, "package.json")) &&
      nativeAddons.some((candidate) => existsSync(candidate)),
  );
if (!betterSqliteRuntime) {
  throw new Error(
    `Unable to locate a complete Linux x64 better-sqlite3 runtime. Checked: ${betterSqliteCandidates.join(", ")}`,
  );
}
console.log(
  `Copying better-sqlite3 runtime from ${betterSqliteRuntime.packageDirectory}`,
);
mkdirSync(resolve(nativeRoot, "node_modules"), { recursive: true });
writeFileSync(resolve(nativeRoot, "package.json"), "{}\n");
cpSync(
  betterSqliteRuntime.packageDirectory,
  resolve(nativeRoot, "node_modules", "better-sqlite3"),
  { recursive: true, dereference: true },
);
cpSync(
  resolve(repositoryRoot, "apps", "web", "dist"),
  resolve(releaseDirectory, "web", "dist"),
  { recursive: true },
);
copyFileSync(
  resolve(repositoryRoot, "scripts", "run-standalone-server.sh"),
  resolve(releaseDirectory, "start.sh"),
);
chmodSync(resolve(releaseDirectory, "start.sh"), 0o755);

rmSync(buildDirectory, { recursive: true, force: true });
