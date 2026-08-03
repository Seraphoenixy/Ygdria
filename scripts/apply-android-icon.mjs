import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "apps", "mobile", "android", "app", "src", "main");
const manifestPath = path.join(androidRoot, "AndroidManifest.xml");
const iconPath = path.join(androidRoot, "res", "drawable", "ygdria_forest.png");
const sourceIconPath = path.join(root, "assets", "icons", "ygdria-forest.png");

const SHARE_INTENT_FILTERS = `
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/*" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND_MULTIPLE" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/*" />
        </intent-filter>`;

function injectShareIntentFilters(manifest) {
  // Only inject once. Intent filters must be children of the launch activity,
  // not of the application node. Capacitor's generated manifest declares
  // `.MainActivity`; it does not contain the `BridgeActivity` base-class name.
  if (manifest.includes('android.intent.action.SEND')) return manifest;
  const mainActivity = /<activity\b[^>]*\bandroid:name="(?:\.MainActivity|[^"\s]*\.MainActivity)"[^>]*>[\s\S]*?<\/activity>/;
  if (!mainActivity.test(manifest)) {
    throw new Error("Could not find the generated MainActivity in AndroidManifest.xml");
  }
  return manifest.replace(mainActivity, (activity) =>
    activity.replace(/<\/activity>$/, `${SHARE_INTENT_FILTERS}\n    </activity>`),
  );
}

try {
  await mkdir(path.dirname(iconPath), { recursive: true });
  await copyFile(sourceIconPath, iconPath);
  let manifest = await readFile(manifestPath, "utf8");
  manifest = manifest
    // Replace the longer name first: `ic_launcher` is a prefix of
    // `ic_launcher_round` and replacing it first would create a reference to
    // the non-existent `@drawable/ygdria_forest_round`.
    .replaceAll("@mipmap/ic_launcher_round", "@drawable/ygdria_forest")
    .replaceAll("@mipmap/ic_launcher", "@drawable/ygdria_forest")
    .replaceAll("@drawable/ygdria_forest_round", "@drawable/ygdria_forest");
  manifest = injectShareIntentFilters(manifest);
  await writeFile(manifestPath, manifest);
  console.log("Applied Ygdria forest icon to Android resources.");
  console.log("Injected share-target intent filters into AndroidManifest.xml.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Unable to apply Android app icon: ${message}`);
}
