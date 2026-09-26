import { DEFAULT_SETTINGS, Settings, SettingsSchema } from "../shared/types";
import { Store } from "./store";
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
    return row
      ? SettingsSchema.parse(JSON.parse(row.value))
      : structuredClone(DEFAULT_SETTINGS);
  }
  has(provider: "anthropic" | "deepseek") {
    return !!this.store.db
      .prepare("SELECT key FROM settings WHERE key=?")
      .get("key:" + provider);
  }
  view() {
    return {
      values: this.get(),
      keys: {
        anthropic: this.has("anthropic"),
        deepseek: this.has("deepseek"),
      },
      secureStorage: this.available(),
    };
  }
  save(settings: Settings, keys: { anthropic?: string; deepseek?: string }) {
    const value = SettingsSchema.parse(settings);
    const encrypted: Record<string, string> = {};
    for (const provider of ["anthropic", "deepseek"] as const) {
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
  key(provider: "anthropic" | "deepseek") {
    if (!this.available())
      throw new Error("Unlock OS secure storage before using a provider.");
    const row = this.store.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("key:" + provider) as { value: string } | undefined;
    if (!row) throw new Error("Enter the provider API key in Settings first.");
    return this.secure.decryptString(Buffer.from(row.value, "base64"));
  }
}
