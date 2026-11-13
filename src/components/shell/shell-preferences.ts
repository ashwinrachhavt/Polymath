import type { AccentValue, AppearanceValue, InterfaceModeValue } from "@/domains/identity/preferences";

export type ShellPreferenceSnapshot =
  | { scope: string; kind: "ready"; version: number; appearance: AppearanceValue; accent: AccentValue }
  | { scope: string; kind: "unavailable"; authenticated: boolean };

export type ShellPreferencePatch =
  { appearance: AppearanceValue } | { interfaceMode: Exclude<InterfaceModeValue, "auto"> } | { accent: AccentValue };

export type SaveShellPreference = (patch: ShellPreferencePatch) => Promise<boolean>;
