import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "apps", "mobile", "android", "app", "src", "main");
const manifestPath = path.join(androidRoot, "AndroidManifest.xml");
const iconPath = path.join(androidRoot, "res", "drawable", "ygdria_forest.png");
const sourceIconPath = path.join(root, "assets", "icons", "ygdria-forest.png");

try {
  await mkdir(path.dirname(iconPath), { recursive: true });
  await copyFile(sourceIconPath, iconPath);
  const manifest = await readFile(manifestPath, "utf8");
  const updated = manifest
    // Replace the longer name first: `ic_launcher` is a prefix of
    // `ic_launcher_round` and replacing it first would create a reference to
    // the non-existent `@drawable/ygdria_forest_round`.
    .replaceAll("@mipmap/ic_launcher_round", "@drawable/ygdria_forest")
    .replaceAll("@mipmap/ic_launcher", "@drawable/ygdria_forest")
    .replaceAll("@drawable/ygdria_forest_round", "@drawable/ygdria_forest");
  await writeFile(manifestPath, updated);
  console.log("Applied Ygdria forest icon to Android resources.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Unable to apply Android app icon: ${message}`);
}
