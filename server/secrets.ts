import { existsSync, readFileSync } from "node:fs";
import { SECRETS_PATH } from "./paths.js";

export function getPrivateKey(): `0x${string}` | null {
  const env = process.env.PRIVATE_KEY?.trim();
  if (env && /^0x[a-fA-F0-9]{64}$/.test(env)) return env as `0x${string}`;
  if (!existsSync(SECRETS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as { privateKey?: string };
    const pk = raw.privateKey?.trim() ?? "";
    if (pk && /^0x[a-fA-F0-9]{64}$/.test(pk)) return pk as `0x${string}`;
  } catch {
    /* ignore */
  }
  return null;
}

export function privateKeyConfigured(): boolean {
  return getPrivateKey() != null;
}
