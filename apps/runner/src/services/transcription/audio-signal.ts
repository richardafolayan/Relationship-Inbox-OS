import { readFileSync } from "node:fs";

export interface AudioSignalSummary {
  durationSeconds: number;
  peak: number;
  rms: number;
}

export function analyzeMonoPcm16Wav(buffer: Buffer): AudioSignalSummary {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("wav: invalid header");
  }

  let offset = 12;
  let sampleRate = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buffer.length) throw new Error("wav: truncated chunk");
    if (chunkId === "fmt " && chunkSize >= 16) {
      const pcm = buffer.readUInt16LE(chunkStart) === 1;
      const mono = buffer.readUInt16LE(chunkStart + 2) === 1;
      const int16 = buffer.readUInt16LE(chunkStart + 14) === 16;
      if (!pcm || !mono || !int16) throw new Error("wav: unsupported format");
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
    }
    if (chunkId === "data") {
      dataOffset = chunkStart;
      dataLength = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize & 1);
  }

  if (!sampleRate || dataOffset < 0) throw new Error("wav: missing audio data");
  const sampleCount = Math.floor(dataLength / 2);
  if (sampleCount === 0) return { durationSeconds: 0, peak: 0, rms: 0 };

  let peak = 0;
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = buffer.readInt16LE(dataOffset + index * 2) / 32768;
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    sumSquares += sample * sample;
  }
  return {
    durationSeconds: sampleCount / sampleRate,
    peak,
    rms: Math.sqrt(sumSquares / sampleCount)
  };
}

export function readAudioSignalSummary(path: string): AudioSignalSummary {
  return analyzeMonoPcm16Wav(readFileSync(path));
}

export function hasAudibleSpeechSignal(summary: AudioSignalSummary): boolean {
  return summary.durationSeconds >= 0.35 && summary.peak >= 0.008 && summary.rms >= 0.0008;
}
