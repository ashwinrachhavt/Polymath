import type { AppearanceValue, InterfaceModeValue } from "@/domains/identity/preferences";

export type ShellPreferenceSnapshot =
  | { scope: string; kind: "ready"; version: number; appearance: AppearanceValue }
  | { scope: string; kind: "unavailable"; authenticated: boolean };

export type ShellPreferencePatch =
  { appearance: AppearanceValue } | { interfaceMode: Exclude<InterfaceModeValue, "auto"> };

export type SaveShellPreference = (patch: ShellPreferencePatch) => Promise<boolean>;
