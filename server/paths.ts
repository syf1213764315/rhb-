import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const DATA_DIR = resolve(ROOT, "data");
export const SETTINGS_PATH = resolve(DATA_DIR, "settings.json");
export const SECRETS_PATH = resolve(ROOT, "config.json");
