import type { ProviderModel } from "./llm.ts";
import { channelSupportsVision } from "./llm.ts";
import { secretValue, type ProviderSecrets } from "./provider-secrets.ts";

export interface CodeScreenshotAttachment {
  id?: string;
  name?: string;
  mimeType: string;
  data: string;
}

const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_BASE64_CHARS = 5_500_000;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function normalizeScreenshotAttachments(value: unknown): CodeScreenshotAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: CodeScreenshotAttachment[] = [];
  for (const raw of value) {
    if (attachments.length >= MAX_SCREENSHOTS) break;
    const row = jsonObject(raw);
    const parsed = parseImagePayload(asString(row.dataUrl) || asString(row.data));
    const mimeType = (asString(row.mimeType) || parsed.mimeType).toLowerCase();
    const data = parsed.data || asString(row.data);
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType) || !data) continue;
    if (data.length > MAX_SCREENSHOT_BASE64_CHARS) {
      throw new Error("Screenshot is too large. Try cropping it or pasting a smaller image.");
    }
    attachments.push({
      id: asString(row.id) || undefined,
      name: asString(row.name).slice(0, 120) || undefined,
      mimeType,
      data,
    });
  }
  return attachments;
}

export async function describeCodeScreenshots(
  channel: ProviderModel,
  screenshots: CodeScreenshotAttachment[],
  task: string,
  providerSecrets?: ProviderSecrets,
): Promise<string> {
  if (!screenshots.length) return "";
  if (!channelSupportsVision(channel)) {
    throw new Error(`Screenshots were attached, but ${channel.label} does not support vision. Choose Gemini or Claude, or remove the screenshot.`);
  }

  const prompt = [
    "You are preparing visual context for a coding agent.",
    "Describe the attached screenshot(s) as concise engineering notes.",
    "Focus on visible UI state, text, errors, layout, controls, browser URL, and what seems relevant to the user's coding request.",
    "Do not infer hidden code. Do not invent requirements. If text is unreadable, say so.",
    "",
    "User coding request:",
    task,
    "",
    "Return markdown with these sections:",
    "## Visual Context",
    "- ...",
    "## Potentially Relevant Details",
    "- ...",
  ].join("\n");

  if (channel.provider === "gemini") return describeWithGemini(channel, prompt, screenshots, providerSecrets);
  if (channel.provider === "openai") return describeWithOpenAI(channel, prompt, screenshots, providerSecrets);
  if (channel.provider === "anthropic") return describeWithAnthropic(channel, prompt, screenshots, providerSecrets);
  throw new Error(`Vision is not implemented for ${channel.provider}.`);
}

async function describeWithGemini(
  channel: ProviderModel,
  prompt: string,
  screenshots: CodeScreenshotAttachment[],
  providerSecrets?: ProviderSecrets,
): Promise<string> {
  const key = secretValue(providerSecrets, "GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${channel.model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          ...screenshots.map((screenshot) => ({
            inlineData: {
              mimeType: screenshot.mimeType,
              data: screenshot.data,
            },
          })),
        ],
      }],
      generationConfig: { maxOutputTokens: 1400 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini vision error (${res.status}): ${body}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const first = jsonObject(candidates[0]);
  const content = jsonObject(first.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => asString(jsonObject(part).text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function describeWithOpenAI(
  channel: ProviderModel,
  prompt: string,
  screenshots: CodeScreenshotAttachment[],
  providerSecrets?: ProviderSecrets,
): Promise<string> {
  const key = secretValue(providerSecrets, "OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: channel.model,
      max_completion_tokens: 1400,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...screenshots.map((screenshot) => ({
            type: "image_url",
            image_url: {
              url: `data:${screenshot.mimeType};base64,${screenshot.data}`,
            },
          })),
        ],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI vision error (${res.status}): ${body}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = jsonObject(choices[0]);
  const message = jsonObject(first.message);
  return asString(message.content).trim();
}

async function describeWithAnthropic(
  channel: ProviderModel,
  prompt: string,
  screenshots: CodeScreenshotAttachment[],
  providerSecrets?: ProviderSecrets,
): Promise<string> {
  const key = secretValue(providerSecrets, "ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: channel.model,
      max_tokens: 1400,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...screenshots.map((screenshot) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: screenshot.mimeType,
              data: screenshot.data,
            },
          })),
        ],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic vision error (${res.status}): ${body}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const blocks = Array.isArray(data.content) ? data.content : [];
  return blocks
    .map((block) => asString(jsonObject(block).text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseImagePayload(value: string): { mimeType: string; data: string } {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/i);
  if (!match) return { mimeType: "", data: "" };
  return { mimeType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, "") };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
