import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "com.ygdria.app",
  appName: "Ygdria",
  webDir: "../web/dist",
  server: { androidScheme: "https" },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: "#0f172a",
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      resizeOnFullScreen: true,
    },
  },
};
export default config;
