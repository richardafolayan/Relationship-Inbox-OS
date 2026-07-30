import { z } from "zod";
import { prisma } from "../db";

export const DICTATION_MESSAGE_EXAMPLES_SETTING_KEY = "dictation.messageExamples";
const MAX_EXAMPLES = 12;
const MAX_MESSAGES_PER_EXAMPLE = 12;
const MAX_MESSAGE_LENGTH = 800;

const examplesSchema = z.array(
  z
    .object({
      messages: z.array(z.string()).min(1).max(MAX_MESSAGES_PER_EXAMPLE)
    })
    .strict()
);

export interface DictationMessageExample {
  messages: string[];
}

let writeQueue = Promise.resolve();

function normaliseMessages(messages: string[]): string[] {
  return messages
    .map((message) => message.replace(/\s+/gu, " ").trim().slice(0, MAX_MESSAGE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_MESSAGES_PER_EXAMPLE);
}

export function parseDictationMessageExamples(value: unknown): DictationMessageExample[] {
  const parsed = examplesSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data
    .map((example) => ({ messages: normaliseMessages(example.messages) }))
    .filter((example) => example.messages.length > 0)
    .slice(0, MAX_EXAMPLES);
}

export function mergeDictationMessageExamples(
  current: DictationMessageExample[],
  messages: string[]
): DictationMessageExample[] {
  const normalised = normaliseMessages(messages);
  const normalisedCurrent = current
    .map((example) => ({ messages: normaliseMessages(example.messages) }))
    .filter((example) => example.messages.length > 0);
  if (!normalised.length) return normalisedCurrent.slice(0, MAX_EXAMPLES);
  const key = JSON.stringify(normalised);
  return [
    { messages: normalised },
    ...normalisedCurrent.filter((example) => JSON.stringify(example.messages) !== key)
  ].slice(0, MAX_EXAMPLES);
}

export async function loadDictationMessageExamples(): Promise<DictationMessageExample[]> {
  const row = await prisma.setting.findUnique({
    where: { key: DICTATION_MESSAGE_EXAMPLES_SETTING_KEY }
  });
  if (!row) return [];
  try {
    return parseDictationMessageExamples(JSON.parse(row.valueJson));
  } catch {
    return [];
  }
}

export async function rememberDictationMessageExample(
  messages: string[]
): Promise<DictationMessageExample[]> {
  const write = writeQueue.then(async () => {
    const next = mergeDictationMessageExamples(
      await loadDictationMessageExamples(),
      messages
    );
    await prisma.setting.upsert({
      where: { key: DICTATION_MESSAGE_EXAMPLES_SETTING_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: {
        key: DICTATION_MESSAGE_EXAMPLES_SETTING_KEY,
        valueJson: JSON.stringify(next)
      }
    });
    return next;
  });
  writeQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}
