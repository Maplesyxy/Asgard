import {
  CREDENTIAL,
  DEFAULT_SETTINGS,
  KeyPresence,
  RETIRED_ANTHROPIC_MODELS,
  RETIRED_DEFAULTS,
  Settings,
  SettingsSchema,
} from "../shared/types";
import { Store } from "./store";
export type Credential = (typeof CREDENTIAL)[keyof typeof CREDENTIAL];
export const CREDENTIALS = [
  "anthropic",
  "openai",
  "deepseek",
  "gemini",
] as const satisfies readonly Credential[];
export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export class SettingsStore {
  constructor(
    private store: Store,
    private secure: SecureStorage,
  ) {}
  available() {
    return (
      this.secure.isEncryptionAvailable() &&
      this.secure.getSelectedStorageBackend?.() !== "basic_text"
    );
  }
  get(): Settings {
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key='config'")
      .get() as { value: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    // A config written by an older build is missing the keys added since.
    // Merging defaults first keeps an upgrade from failing the strict schema,
    // and retires model ids this app itself shipped before they existed.
    const stored = JSON.parse(row.value) as Record<string, unknown>;
    const merged = { ...structuredClone(DEFAULT_SETTINGS), ...stored };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[])
      if (merged[key] === undefined || merged[key] === null)
        (merged as Record<string, unknown>)[key] = structuredClone(
          DEFAULT_SETTINGS[key],
        );
    if (
      typeof merged.anthropicModel === "string" &&
      RETIRED_ANTHROPIC_MODELS.includes(merged.anthropicModel)
    )
      merged.anthropicModel = DEFAULT_SETTINGS.anthropicModel;
    // An output ceiling of 8192 with thinking on is why answers came back
    // empty: reasoning consumed the budget. Values still equal to a retired
    // default are moved forward; anything the user chose is kept.
    for (const [name, olds] of Object.entries(RETIRED_DEFAULTS)) {
      const key = name as keyof Settings;
      const current = JSON.stringify(merged[key]);
      if (olds.some((old) => JSON.stringify(old) === current))
        (merged as Record<string, unknown>)[key] = structuredClone(
          DEFAULT_SETTINGS[key],
        );
    }
    return SettingsSchema.parse(merged);
  }
  has(provider: Credential) {
    return !!this.store.db
      .prepare("SELECT key FROM settings WHERE key=?")
      .get("key:" + provider);
  }
  keys(): KeyPresence {
    return {
      anthropic: this.has("anthropic"),
      openai: this.has("openai"),
      deepseek: this.has("deepseek"),
      gemini: this.has("gemini"),
    };
  }
  view() {
    return {
      values: this.get(),
      keys: this.keys(),
      secureStorage: this.available(),
    };
  }
  save(settings: Settings, keys: Partial<Record<Credential, string>>) {
    const value = SettingsSchema.parse(settings);
    const encrypted: Record<string, string> = {};
    for (const provider of CREDENTIALS) {
      const key = keys[provider];
      if (key === undefined || key === "") continue;
      if (!this.available())
        throw new Error(
          "OS secure storage is unavailable. Credentials were not saved.",
        );
      encrypted[provider] = this.secure
        .encryptString(key.trim())
        .toString("base64");
    }
    this.store.db.transaction(() => {
      this.store.db
        .prepare("INSERT OR REPLACE INTO settings VALUES('config',?)")
        .run(JSON.stringify(value));
      for (const [p, v] of Object.entries(encrypted))
        this.store.db
          .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
          .run("key:" + p, v);
    })();
  }
  forget(provider: Credential) {
    this.store.db
      .prepare("DELETE FROM settings WHERE key=?")
      .run("key:" + provider);
  }
  key(provider: Credential) {
    if (!this.available())
      throw new Error("Unlock OS secure storage before using a provider.");
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("key:" + provider) as { value: string } | undefined;
    if (!row) throw new Error("Enter the provider API key in Settings first.");
    return this.secure.decryptString(Buffer.from(row.value, "base64"));
  }
}
