import type { OperatorProfile } from "../types/runtime";

export interface MechanicalWritingRules {
  forbidFullStops: boolean;
  forbidExclamationMarks: boolean;
  forbidQuestionMarks: boolean;
  forbidEmoji: boolean;
  allLowercase: boolean;
}

export type MechanicalWritingRuleIssue =
  | "full_stop"
  | "exclamation_mark"
  | "question_mark"
  | "emoji"
  | "uppercase";

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

function statesBan(source: string, terms: string): boolean {
  return new RegExp(
    `(?:\\bno\\b|\\bnever\\b|\\bdo\\s+not\\b|\\bdon['’]?t\\b|\\bavoid\\b|\\bwithout\\b)[^.!?\\n]{0,32}(?:${terms})`,
    "i"
  ).test(source);
}

export function deriveMechanicalWritingRules(
  profile: OperatorProfile | null | undefined
): MechanicalWritingRules {
  const source = [profile?.about, profile?.avoidedPhrases].filter(Boolean).join("\n");
  return {
    // Only worded rule statements ("never use exclamation marks") count.
    // Matching the characters themselves turned ordinary profile prose
    // ("I never use jargon!") or an avoided phrase containing punctuation
    // ("no worries!") into a global ban.
    forbidFullStops: statesBan(source, "full\\s*stops?|periods?|\\bdots?\\b"),
    forbidExclamationMarks: statesBan(source, "exclamation(?:\\s+marks?|\\s+points?)?\\b"),
    forbidQuestionMarks: statesBan(source, "question\\s+marks?"),
    forbidEmoji: statesBan(source, "emojis?|emoticons?"),
    allLowercase:
      /\b(?:all|always|only|write|writes|writing|message|messages|text|texts|typing)\b[^.!?\n]{0,24}\blower[ -]?case\b/i.test(
        source
      ) && !/\b(?:do\s+not|don['’]?t|never|avoid|no)\b[^.!?\n]{0,16}\blower[ -]?case\b/i.test(source)
  };
}

export function validateMechanicalWritingRules(
  text: string,
  rules: MechanicalWritingRules
): MechanicalWritingRuleIssue[] {
  const issues: MechanicalWritingRuleIssue[] = [];
  if (rules.forbidFullStops && text.includes(".")) issues.push("full_stop");
  if (rules.forbidExclamationMarks && text.includes("!")) issues.push("exclamation_mark");
  if (rules.forbidQuestionMarks && text.includes("?")) issues.push("question_mark");
  if (rules.forbidEmoji && EMOJI_PATTERN.test(text)) issues.push("emoji");
  if (rules.allLowercase && /[A-Z]/.test(text)) issues.push("uppercase");
  return issues;
}

export function repairMechanicalWritingRules(
  text: string,
  rules: MechanicalWritingRules
): string {
  let repaired = text;
  if (rules.forbidFullStops) repaired = repaired.replace(/\./g, "");
  if (rules.forbidExclamationMarks) repaired = repaired.replace(/!/g, "");
  if (rules.forbidQuestionMarks) repaired = repaired.replace(/\?/g, "");
  if (rules.forbidEmoji) repaired = repaired.replace(/\p{Extended_Pictographic}/gu, "");
  if (rules.allLowercase) repaired = repaired.toLowerCase();
  return repaired.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim();
}

export function mechanicalWritingRulesPromptFragment(
  profile: OperatorProfile | null | undefined
): string {
  const rules = deriveMechanicalWritingRules(profile);
  const lines: string[] = [];
  if (rules.forbidFullStops) lines.push("- Do not use full stops anywhere.");
  if (rules.forbidExclamationMarks) lines.push("- Do not use exclamation marks anywhere.");
  if (rules.forbidQuestionMarks) lines.push("- Do not use question marks anywhere.");
  if (rules.forbidEmoji) lines.push("- Do not use emoji.");
  if (rules.allLowercase) lines.push("- Use lowercase throughout, including the first word.");
  if (lines.length === 0) return "";
  return `\n\nMECHANICAL VOICE RULES (strict, validated after generation):\n${lines.join("\n")}`;
}
