export type ModelProfile = {
  modelId: string;
  apiKey: string;
};

export const parseModelProfiles = (raw: string): ModelProfile[] => {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
        const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
        if (!modelId || !apiKey) return null;
        return { modelId, apiKey };
      })
      .filter((profile): profile is ModelProfile => profile !== null);
  } catch {
    return [];
  }
};

export const serializeModelProfiles = (profiles: ModelProfile[]): string =>
  JSON.stringify(profiles);

export const findModelProfile = (
  profiles: ModelProfile[],
  modelId: string
): ModelProfile | undefined => profiles.find((profile) => profile.modelId === modelId);

export const getActiveModelProfile = (
  profiles: ModelProfile[],
  activeModelId: string
): ModelProfile | undefined => findModelProfile(profiles, activeModelId);

export const formatModelLabel = (modelId: string): string => {
  const slash = modelId.indexOf("/");
  if (slash === -1) return modelId;
  const provider = modelId.slice(0, slash);
  const name = modelId.slice(slash + 1);
  return `${name} (${provider})`;
};

const TEXT_MODEL_BLOCKLIST =
  /embedding|whisper|tts|image|audio|transcrib|dall-?e|moderation|realtime|speech/i;

export const isLikelyTextChatModel = (modelId: string): boolean =>
  Boolean(modelId.trim()) && !TEXT_MODEL_BLOCKLIST.test(modelId);

export const filterTextChatModels = (modelIds: string[]): string[] =>
  [...new Set(modelIds.filter(isLikelyTextChatModel))].sort((a, b) => a.localeCompare(b));
