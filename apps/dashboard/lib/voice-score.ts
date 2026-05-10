// Local heuristic voice scorer. Runs on every keystroke (debounced)
// without paying for an LLM call. The signals are coarse but capture
// the kind of drift that's easy to introduce when editing an AI draft:
//
//   - opener style (does the operator usually greet by name?)
//   - sentence length compared to corpus average
//   - exclamation density
//   - emoji density
//
// Scores roughly to:
//   80-100 -> on-voice (green)
//   55-79  -> drifting (amber)
//   <55    -> off-voice (red, surfaces the "Rewrite in my voice" affordance)
//
// Returns the signals so the UI can render the most informative one in
// a tooltip ("opens with 'Hi {name}!' - your voice rarely uses
// exclamation in openers").

export interface VoiceCorpusStats {
  sampleCount: number;
  averageSentenceLength: number;
  greetByNameRate: number; // 0..1
  exclamationsPerSentence: number;
  emojisPerSentence: number;
  averageMessageLength: number;
}

export interface VoiceScoreSignals {
  signal: string;
  delta: number; // how far the draft deviates on this signal (0..1+)
}

export interface VoiceScoreResult {
  score: number; // 0..100
  band: "green" | "amber" | "red";
  signals: VoiceScoreSignals[];
  corpusSize: number;
}

const SENTENCE_RE = /[.!?]+\s+|[.!?]+$/;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

function looksLikeNameGreeting(text: string): boolean {
  // Match "Hey Sam,", "Hi Sam!", "Hello Sam." at the start.
  return /^(hey|hi|hello|yo)\s+[A-Z][\w'-]+/i.test(text.trimStart());
}

export function buildCorpusStats(samples: string[]): VoiceCorpusStats {
  const cleaned = samples
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (cleaned.length === 0) {
    return {
      sampleCount: 0,
      averageSentenceLength: 0,
      greetByNameRate: 0,
      exclamationsPerSentence: 0,
      emojisPerSentence: 0,
      averageMessageLength: 0
    };
  }

  let totalSentences = 0;
  let totalSentenceLengthChars = 0;
  let totalExclamations = 0;
  let totalEmojis = 0;
  let greetingCount = 0;
  let totalLength = 0;

  for (const sample of cleaned) {
    if (looksLikeNameGreeting(sample)) greetingCount += 1;
    totalLength += sample.length;
    const sentences = splitSentences(sample);
    totalSentences += Math.max(1, sentences.length);
    for (const sentence of sentences.length > 0 ? sentences : [sample]) {
      totalSentenceLengthChars += sentence.length;
      totalExclamations += (sentence.match(/!/g) ?? []).length;
      totalEmojis += (sentence.match(EMOJI_RE) ?? []).length;
    }
  }

  return {
    sampleCount: cleaned.length,
    averageSentenceLength: totalSentenceLengthChars / Math.max(1, totalSentences),
    greetByNameRate: greetingCount / cleaned.length,
    exclamationsPerSentence: totalExclamations / Math.max(1, totalSentences),
    emojisPerSentence: totalEmojis / Math.max(1, totalSentences),
    averageMessageLength: totalLength / cleaned.length
  };
}

export function scoreDraftAgainstCorpus(draft: string, corpus: VoiceCorpusStats): VoiceScoreResult {
  const trimmed = draft.trim();
  if (!trimmed || corpus.sampleCount === 0) {
    return { score: 100, band: "green", signals: [], corpusSize: corpus.sampleCount };
  }

  const sentences = splitSentences(trimmed);
  const draftAvgSentenceLength =
    sentences.reduce((sum, s) => sum + s.length, 0) / Math.max(1, sentences.length);
  const draftExclamations = (trimmed.match(/!/g) ?? []).length / Math.max(1, sentences.length);
  const draftEmojis = (trimmed.match(EMOJI_RE) ?? []).length / Math.max(1, sentences.length);
  const draftGreets = looksLikeNameGreeting(trimmed) ? 1 : 0;

  const signals: VoiceScoreSignals[] = [];
  let penalty = 0;

  // Sentence length deviation. Half-or-double the corpus average is a
  // strong signal - operator's voice changed register or copy-pasted.
  if (corpus.averageSentenceLength > 0) {
    const ratio = draftAvgSentenceLength / corpus.averageSentenceLength;
    const drift = Math.abs(Math.log2(Math.max(0.25, ratio))); // log-scale so 2x and 0.5x are equal
    if (drift > 0.3) {
      penalty += Math.min(30, drift * 25);
      signals.push({
        signal:
          ratio > 1
            ? `Sentence length ${Math.round(draftAvgSentenceLength)} chars vs your usual ${Math.round(corpus.averageSentenceLength)}`
            : `Sentences are shorter than your usual (${Math.round(corpus.averageSentenceLength)} chars)`,
        delta: drift
      });
    }
  }

  // Greeting style.
  if (draftGreets === 1 && corpus.greetByNameRate < 0.2) {
    penalty += 12;
    signals.push({
      signal: "Opens with 'Hi {Name}' - your voice rarely greets by name",
      delta: 1
    });
  } else if (draftGreets === 0 && corpus.greetByNameRate > 0.7) {
    penalty += 8;
    signals.push({
      signal: "No name greeting - you usually open with one",
      delta: 1
    });
  }

  // Exclamation density.
  const exclamationDelta = Math.abs(draftExclamations - corpus.exclamationsPerSentence);
  if (exclamationDelta > 0.5) {
    penalty += Math.min(15, exclamationDelta * 12);
    signals.push({
      signal:
        draftExclamations > corpus.exclamationsPerSentence
          ? "More exclamation marks than your voice"
          : "Less exclamation than your voice",
      delta: exclamationDelta
    });
  }

  // Emoji density.
  const emojiDelta = Math.abs(draftEmojis - corpus.emojisPerSentence);
  if (emojiDelta > 0.5) {
    penalty += Math.min(10, emojiDelta * 8);
    signals.push({
      signal: draftEmojis > corpus.emojisPerSentence ? "Heavier emoji use than your voice" : "No emoji where your voice usually has some",
      delta: emojiDelta
    });
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const band: VoiceScoreResult["band"] = score >= 80 ? "green" : score >= 55 ? "amber" : "red";

  // Sort by largest delta so the most informative signal is first.
  signals.sort((a, b) => b.delta - a.delta);

  return { score, band, signals, corpusSize: corpus.sampleCount };
}
