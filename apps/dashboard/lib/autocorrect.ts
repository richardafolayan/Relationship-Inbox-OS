// #466 (pilot R-0065): lightweight, conservative autocorrect for the reply
// composer. Desktop Firefox (the pilot's browser) honours `spellCheck` but
// NOT the iOS-only `autoCorrect`/`autoCapitalize` attributes, so a native-
// only solution would do nothing for them. This module provides a tiny
// JS layer that runs on word-commit (when a whitespace character is typed):
//
//   - fixes a curated set of high-confidence, unambiguous typos,
//   - expands no-apostrophe contractions that aren't valid words on their
//     own (dont -> don't, youre -> you're),
//   - uppercases the standalone pronoun "i" and its contractions,
//   - capitalises the first letter of a sentence.
//
// It is deliberately conservative: it never touches URLs, emails, @handles,
// #hashtags, words with digits, all-caps acronyms, or anything ambiguous,
// and the caller only invokes it when the operator is appending at the end
// of the text (so the caret never jumps and mid-text edits are untouched).
// Every correction is reversible with an immediate Backspace (handled by the
// caller). The functions here are pure so they can be unit-tested without a
// DOM.

// Curated typos. Each key is NOT a valid English word, so the correction is
// unambiguous. Keep this list conservative — a wrong "correction" of a word
// the operator meant is worse than a missed typo.
export const COMMON_TYPOS: Record<string, string> = {
  // everyday misspellings
  teh: "the",
  thsi: "this",
  taht: "that",
  adn: "and",
  becuase: "because",
  beacuse: "because",
  becasue: "because",
  beleive: "believe",
  belive: "believe",
  recieve: "receive",
  recieved: "received",
  definately: "definitely",
  defintely: "definitely",
  seperate: "separate",
  occured: "occurred",
  untill: "until",
  wich: "which",
  thier: "their",
  freind: "friend",
  freinds: "friends",
  wierd: "weird",
  tommorow: "tomorrow",
  tomorow: "tomorrow",
  tommorrow: "tomorrow",
  calender: "calendar",
  neccessary: "necessary",
  accomodate: "accommodate",
  gaurd: "guard",
  garantee: "guarantee",
  embarass: "embarrass",
  occassion: "occasion",
  arguement: "argument",
  enviroment: "environment",
  goverment: "government",
  independant: "independent",
  maintainance: "maintenance",
  mispell: "misspell",
  noticable: "noticeable",
  persistant: "persistent",
  priviledge: "privilege",
  suprise: "surprise",
  surprize: "surprise",
  truely: "truly",
  wether: "whether",
  waht: "what",
  wnat: "want",
  jsut: "just",
  liek: "like",
  alos: "also",
  abou: "about",
  abot: "about",
  acn: "can",
  cna: "can",
  donig: "doing",
  goign: "going",
  haev: "have",
  hvae: "have",
  knwo: "know",
  konw: "know",
  needd: "need",
  realy: "really",
  reaaly: "really",
  shoudl: "should",
  smoe: "some",
  somthing: "something",
  soemthing: "something",
  tahnks: "thanks",
  thanx: "thanks",
  thnaks: "thanks",
  wnated: "wanted",
  woudl: "would",
  yetserday: "yesterday",
  yesteday: "yesterday",
  // no-apostrophe contractions where the bare form is not a valid word
  dont: "don't",
  doesnt: "doesn't",
  didnt: "didn't",
  isnt: "isn't",
  arent: "aren't",
  wasnt: "wasn't",
  werent: "weren't",
  havent: "haven't",
  hasnt: "hasn't",
  hadnt: "hadn't",
  couldnt: "couldn't",
  shouldnt: "shouldn't",
  wouldnt: "wouldn't",
  youre: "you're",
  youve: "you've",
  theyre: "they're",
  theyve: "they've",
  thats: "that's",
  whats: "what's",
  im: "I'm",
  ive: "I've"
};

/** Whitespace characters that "commit" the word before them. */
export function isWordCommit(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

// A word we should never touch: URLs, emails, @handles / #hashtags, words
// containing digits, or all-caps acronyms (>1 char). Apostrophes are allowed
// (so we don't re-touch "don't").
function isProtectedWord(word: string): boolean {
  if (/[@#/0-9]/.test(word)) return true; // handle, hashtag, url, email, number
  if (/[.:]/.test(word)) return true; // domain, time, ratio, abbreviation
  if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return true; // acronym
  return false;
}

function matchLeadingCase(original: string, corrected: string): string {
  // If the user capitalised the first letter (Teh -> The), keep it.
  const first = original[0];
  if (first && first === first.toUpperCase() && /[a-z]/i.test(first)) {
    return corrected.charAt(0).toUpperCase() + corrected.slice(1);
  }
  return corrected;
}

/**
 * Correct a single committed word. `atSentenceStart` capitalises the first
 * letter when the word begins a sentence. Returns the (possibly unchanged)
 * word.
 */
export function correctWord(word: string, atSentenceStart: boolean): string {
  if (!word) return word;
  if (isProtectedWord(word)) return word;

  let result = word;

  // Standalone "i" and its contractions -> "I" / "I'm" etc.
  const lower = result.toLowerCase();
  if (lower === "i") {
    result = "I";
  } else if (/^i'[a-z]+$/.test(lower)) {
    result = "I" + result.slice(1);
  } else {
    // Curated typo / contraction map (case-insensitive lookup).
    const mapped = COMMON_TYPOS[lower];
    if (mapped) {
      result = matchLeadingCase(result, mapped);
    }
  }

  // Sentence-start capitalisation (applied last so it also lifts a
  // lowercase first word that wasn't otherwise corrected).
  if (atSentenceStart && /^[a-z]/.test(result)) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  return result;
}

export interface AutocorrectResult {
  /** The full text with the corrected word substituted. */
  text: string;
  /** Start index of the corrected word (for an undo). */
  start: number;
  /** The original word, so the caller can offer an immediate-backspace undo. */
  original: string;
  /** The corrected word that replaced it. */
  corrected: string;
}

// True when the word starting at `start` begins a sentence: nothing but
// whitespace precedes it back to either the start of the text or a sentence
// terminator (. ! ?).
function startsSentence(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && isWordCommit(text[i])) i--;
  if (i < 0) return true;
  return text[i] === "." || text[i] === "!" || text[i] === "?";
}

/**
 * Given the full composer `text` and a `caret` that sits immediately after a
 * freshly typed whitespace character, correct the word that the whitespace
 * just committed. Returns null when nothing changed.
 *
 * Caller contract: only invoke this on a single-character append at the end
 * of the text, so substituting the word never disturbs the caret.
 */
export function autocorrectAtCaret(text: string, caret: number): AutocorrectResult | null {
  if (caret < 2 || caret > text.length) return null;
  const terminator = text[caret - 1];
  if (!isWordCommit(terminator)) return null;

  // Find the word ending at caret - 1 (the char before the terminator).
  let start = caret - 1;
  while (start > 0 && !isWordCommit(text[start - 1])) start--;
  const word = text.slice(start, caret - 1);
  if (!word) return null;

  const fixed = correctWord(word, startsSentence(text, start));
  if (fixed === word) return null;

  return {
    text: text.slice(0, start) + fixed + text.slice(caret - 1),
    start,
    original: word,
    corrected: fixed
  };
}
