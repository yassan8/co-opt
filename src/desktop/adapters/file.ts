import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "../ipc/client";

export async function openJsonFromNativeDialog(): Promise<{ path: string; content: string } | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (!selected || Array.isArray(selected)) {
    return null;
  }

  const result = await readTextFile({ path: selected });
  return { path: result.path, content: result.content };
}

export async function saveJsonFromNativeDialog(content: string): Promise<string | null> {
  const target = await save({
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (!target) {
    return null;
  }

  const result = await writeTextFile({ path: target, content });
  return result.path;
}
