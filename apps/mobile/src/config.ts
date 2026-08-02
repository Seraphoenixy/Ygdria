import { Preferences } from "@capacitor/preferences";
/** Android only talks to an HTTPS Fastify deployment; credentials remain in platform storage. */
export async function setApiEndpoint(url: string) {
  if (!url.startsWith("https://")) throw new Error("Ygdria mobile requires HTTPS");
  await Preferences.set({ key: "ygdria.api", value: url });
}
export async function getApiEndpoint() {
  return (await Preferences.get({ key: "ygdria.api" })).value;
}
// TODO: add network retry/offline banner and local draft cache without claiming offline sync.
