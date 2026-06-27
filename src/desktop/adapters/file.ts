import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../ipc/client";

export async function openTextFromNativeDialog(options?: {
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<{ path: string; content: string } | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: options?.filters,
  });

  if (!selected || Array.isArray(selected)) {
    return null;
  }

  const result = await readTextFile({ path: selected });
  return { path: result.path, content: result.content };
}

export async function saveTextFromNativeDialog(
  content: string,
  options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
  },
): Promise<string | null> {
  const target = await save({
    filters: options?.filters,
  });

  if (!target) {
    return null;
  }

  const result = await writeTextFile({ path: target, content });
  return result.path;
}

export async function openJsonFromNativeDialog(): Promise<{ path: string; content: string } | null> {
  return openTextFromNativeDialog({
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
}

export async function saveJsonFromNativeDialog(content: string): Promise<string | null> {
  return saveTextFromNativeDialog(content, {
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
}
