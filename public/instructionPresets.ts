export type InstructionPreset = {
  id: string;
  name: string;
  instructions: string;
};

export const BUILTIN_PRESET_ID = "__builtin__";

export const createPresetId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `preset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const parseInstructionPresets = (raw: string): InstructionPreset[] => {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : "";
        const instructions = typeof record.instructions === "string" ? record.instructions : "";
        if (!id || !name) return null;
        return { id, name, instructions };
      })
      .filter((preset): preset is InstructionPreset => preset !== null);
  } catch {
    return [];
  }
};

export const serializeInstructionPresets = (presets: InstructionPreset[]): string =>
  JSON.stringify(presets);

export const findPresetById = (
  presets: InstructionPreset[],
  id: string
): InstructionPreset | undefined => presets.find((preset) => preset.id === id);

export const findPresetByName = (
  presets: InstructionPreset[],
  name: string
): InstructionPreset | undefined =>
  presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());

export const resolveSelectedPresetId = (
  systemPrompt: string,
  presets: InstructionPreset[],
  storedId: string | null
): string | null => {
  if (storedId === BUILTIN_PRESET_ID) {
    return systemPrompt.trim() ? null : BUILTIN_PRESET_ID;
  }
  if (storedId) {
    const preset = findPresetById(presets, storedId);
    if (preset && preset.instructions === systemPrompt) return storedId;
  }
  if (!systemPrompt.trim()) return BUILTIN_PRESET_ID;
  const matchingPreset = presets.find((preset) => preset.instructions === systemPrompt);
  return matchingPreset?.id ?? null;
};
